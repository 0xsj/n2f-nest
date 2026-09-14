# Identity PostgreSQL store contract

**Stage:** implemented and verified against PostgreSQL 18 in every build on 2026-09-12. This identity-owned adapter implements the store ports the
application layer declared in stage 4 (see ../../app/CONTRACT.md) using the shared
PostgreSQL package and the existing outbox enqueue. It owns SQL, the identity
migration and row-to-domain restoration. Driver types stay inside it. It supplies
no HTTP, mail, rate limiting or process wiring, and it does not choose its ledger
version: root orders migrations.

## Schema

S01 — One migration, exported as a function of the ledger version, creates:
`n2f_identity_principals` (id uuid PK; kind text in human/service; display_name
text 1..100 scalars; status text in active/suspended; created_at_ms, updated_at_ms
bigint; version integer), `n2f_identity_auth_states` (principal_id uuid PK FK;
auth_epoch integer), `n2f_identity_credentials` (principal_id uuid PK FK;
canonical_email text UNIQUE with bytewise semantics via COLLATE "C", at most 254
bytes; password_hash text 1..512 bytes; verified_at_ms bigint NULL;
password_version integer; created_at_ms, changed_at_ms bigint),
`n2f_identity_sessions` (id uuid PK; principal_id FK; token_digest bytea UNIQUE of
exactly 32 bytes; auth_epoch integer; issued_at_ms, last_seen_at_ms,
absolute_expires_at_ms, idle_expires_at_ms bigint; revoked_at_ms bigint NULL) and
`n2f_identity_challenges` (id uuid PK; principal_id FK to credentials; purpose text
in email_verification/password_reset; token_digest bytea of 32 bytes, UNIQUE with
purpose; password_version integer; issued_at_ms, expires_at_ms bigint;
consumed_at_ms, invalidated_at_ms bigint NULL). CHECK constraints duplicate the
domain bounds (time range, version range, ordering of times, A06/A09 relations)
as corruption protection, not as validation. Indexes serve session lookup by
principal and outstanding challenges by principal and purpose. Human-only
credentials are guaranteed by Register, which inserts the principal itself; no
cross-table CHECK claims it. Migration version 5 adds
`n2f_identity_upgrade_tickets` (id uuid PK; session_id FK; unique 32-byte
token_digest; issued_at_ms, expires_at_ms bigint; consumed_at_ms bigint NULL)
with a 30-second maximum lifetime CHECK. Issuance and consumption recheck the
principal, credential, session and auth epoch under the normal lock order.

S02 — Nullable millisecond columns distinguish absent (NULL) from present zero.
Digests are binary, never text. Timestamps are bigint milliseconds. No plain
token, raw password or email other than the canonical login key is stored.

## Transactions

S03 — Every mutation is one shared-package Transaction callback: lock, recheck,
write with guarded updates and affected-row checks, enqueue every envelope from
the record with the existing outbox enqueue on the same transaction, commit.
An enqueue failure (including event ID reuse) fails the transaction. A statement
failure rolls back and passes through the shared classification. A commit failure
passes through unchanged, so `database.commit_uncertain` is never reported as
stale, duplicate or success (A14, D04). No retry. A guarded update that affects
no row while its guards were satisfied under lock is Internal
`identity.store_guard_failed`; password-version exhaustion in change or reset is
Conflict `identity.version_exhausted`.

S04 — Lock order inside every mutation is auth state, then principal, then
credential, then session or challenge, each with SELECT ... FOR UPDATE. A lookup
that starts from a session or challenge digest reads the row without a lock only
to learn its principal, then acquires locks in that order and re-reads. Read ports
(FindByEmail, FindByPrincipal, FindByDigest) take no locks and return snapshots
restored through the domain.

S05 — Rows become domain values through the domain's Restore functions. A stored row the domain refuses is Internal `identity.record_corrupt` carrying
the domain type as a diagnostic detail (public fields are redacted on Internal); a credential whose hash text the domain refuses keeps
`identity.credential_corrupt`. Corruption is never presented as absent or stale.

## Operations

S06 — Register: insert principal, auth state, credential, challenge and events in
that order. A unique violation on canonical_email yields `duplicate_email` after
rollback with nothing inserted; any other failure passes through. Two concurrent
registrations of one canonical email produce exactly one `created`.

S07 — CommitLogin: lock auth state, read principal, credential; principal not
active, credential unverified, password version or epoch differing from the
record's expected values → `stale` after rollback; otherwise insert the session
and enqueue → `committed`.

S08 — Resolve(digest, now, idleTTL): find the session by digest (absent → absent);
lock in order and re-read; restore the Session; a backward `now` relative to the
stored last activity → `rejected` with no write; expiry or revocation → `rejected`,
and an observed expiry is latched by setting revoked_at_ms to now when it is NULL;
then principal must be active, credential verified and the session's epoch equal
to the current auth epoch, else `rejected` with no write; finally apply the domain
Touch(now, idleTTL) with a guarded update and return `admitted` with principal ID,
session ID and epoch. A revocation committed before Resolve begins is always
observed (A08).

S09 — RevokeSession(session, principal, now, events): lock auth state, principal
and then the session (the credential is not needed, and the order is preserved); a session
missing or belonging to another principal → `absent`; already revoked →
`already_inactive` with no write and no event; otherwise apply the domain Revoke
(an expired session is still revocable), update, enqueue → `revoked`.

S10 — RevokeAll(principal, expectedEpoch, now, events): lock auth state; epoch
differs → `stale`; otherwise increment through the domain AuthState, update,
enqueue → `committed`. Session rows are untouched: the epoch is the authority.

S11 — IssueChallenge(record): lock auth state and credential; password version
differs → `stale`; invalidate every outstanding challenge of that principal and
purpose (consumed and invalidated both NULL, expired ones included) at the new
challenge's issue time; insert the new challenge → `committed`.

S12 — VerifyEmail(record): lock auth state and credential; version differs →
`stale`; consume the challenge with one guarded update requiring id, principal,
purpose email_verification, consumed and invalidated NULL, and
issued <= consumedAt < expires; zero rows → `stale`; set verified_at_ms only when
NULL; enqueue → `committed`.

S13 — ChangePassword(record): lock auth state and credential; version or epoch
differs → `stale`; update hash, increment version, set changed_at; increment
epoch; invalidate all outstanding challenges at changed_at; enqueue → `committed`.

S14 — ResetPassword(record): as S13 with the reset challenge consumed first under
the S12 guard (purpose password_reset; zero rows → `stale`), verified_at_ms set
when the record asks and the column is NULL, and the remaining outstanding
challenges invalidated.

## Real verification

S15 — Integration tests run only with `N2F_TEST_DATABASE_URL` pointing at a
disposable PostgreSQL 18 database (skip or ignore otherwise) and apply the events
migration as version 1 and this migration as version 2 through the shared ledger,
twice. Required scenarios: register round trip restoring all records exactly,
including absent timestamps; duplicate after rollback leaves no principal,
challenge or outbox row; concurrent same-email registration with at least eight
workers yields one `created`; each `stale` condition of CommitLogin; Resolve
admitted advances last_seen and idle expiry; idle deadline equality is rejected and
latched; backward time and epoch mismatch are rejected without a write; a revoke
committed before Resolve is observed; at least eight concurrent consumers of one
challenge yield exactly one `committed`; reissue invalidates a previous outstanding
challenge including an expired one; verify with a stale version is `stale`;
ChangePassword bumps the epoch so an earlier session resolves rejected and
invalidates challenges; ResetPassword sets verification; every mutation that carries envelopes rolls back completely when its enqueue
fails (probe: pre-insert an outbox row with the same event ID and a different
payload; IssueChallenge carries none, so its probe is the version guard); outbox rows exist after each committed
mutation and carry no private data. Uncertain commit is not reproduced here; its
classification is the shared package's D04 obligation and the store passes it
through, which the specs show with the shared package's own failure value where a
fake connection is available and otherwise record as unverified.

S16 — Selected mutations against the real database: duplicate_as_failure (the
canonical-email violation is not mapped to `duplicate_email`), stale_login_ignored
(CommitLogin skips the version/epoch recheck), consume_unguarded (the challenge
consume update drops its consumed-NULL predicate so replay succeeds),
backward_time_admitted (Resolve drops the backward-time refusal),
revoke_all_unguarded (RevokeAll skips the expected-epoch guard), events_dropped
(a mutation commits without enqueueing its envelopes).

## Native shapes

Go (`internal/identity/infra/postgres`): `Migration(version int64) db.Migration`;
`type Store struct{ DB *db.DB }` with methods satisfying every store interface in
`app/command` and `query.SessionResolver`; pgx types never leave the package.

Rust (`domains::identity::infra::postgres`): `migration(version: i64) -> Migration`;
`pub struct Store` holding an `Arc<Database>` (`Store::new`), matching the events
adapter and root sharing, implementing the stage 4 port traits with sqlx types
confined to the module.

TypeScript (`modules/identity/infra/postgres`): `migration(version: number)`;
`class Store` implementing the intersection of the stage 4 store interfaces and the
query resolver, with `pg` types confined to the directory.
