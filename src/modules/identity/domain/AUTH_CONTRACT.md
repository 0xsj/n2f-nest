# Identity authentication contract

**Stage:** leaves implemented. The pure value and transition rules of A01–A02 and
A04–A09 are implemented and tested per [AUTH_LEAF_SPEC.md](AUTH_LEAF_SPEC.md);
A03 hashing, A05 token generation and A10–A24 are not implemented or tested yet.
Principal I01–I07 remain the existing implementation. This contract is local to
each blueprint.

## Credentials and login identifiers

A01 — Email is a login identifier, not a principal ID. Baseline accepts ASCII
dot-atom local parts (1..64 bytes, no leading/trailing/consecutive dot) and a DNS
domain (labels 1..63 ASCII alphanumeric/hyphen, no leading/trailing hyphen; at least
two labels), total at most 254 bytes. Exactly one @; no whitespace, display-name
syntax, quoted local part or trailing domain dot. Lowercase the entire address as
an explicit product login policy, not a universal assertion about email. Keep dots
and plus tags; no provider-specific rewriting. Internationalized email is deferred.
Canonical email is unique across password identities; the DB enforces the same
bytewise canonical key. Email is private data, excluded from generic logs.

A02 — New passwords: valid Unicode, NFC-normalized, 15..128 Unicode scalar values
after normalization, at most 512 UTF-8 bytes. Preserve whitespace; do not trim,
case-fold, truncate or require character classes. Reject a locally supplied common/
compromised-password blocklist match on creation/change/reset, not on every login.
Root owns a versioned blocklist source; a tiny test list is not production coverage.
Login uses the same normalization and a finite input size bound, but does not
retroactively apply the current new-password/blocklist policy. No forced periodic
password change without an identified reason. Secret wrappers redact supported
presentation paths; they do not promise memory erasure.

A03 — Password hashing is an identity-owned adapter, not domain arithmetic. Initial
write format is Argon2id v19, m=19456 KiB, t=2, p=1, independent CSPRNG 16-byte salt,
32-byte result, PHC encoding. Use maintained implementations. Verification permits
only a named finite parameter/format allowlist before allocating; initial allowlist
is exactly this format. Future parameter upgrades require explicit read compatibility
and vectors; never trust arbitrary PHC resource requests. Compare with library
verification/constant-time primitives. Mismatch is a value, not a dependency failure.
Malformed stored encoding is an internal credential fault, not a successful mismatch.
Do bounded dummy verification for an absent credential. Hash admission must bound
concurrency and queueing; timeout cannot pretend an in-flight native hash was killed.

A04 — PasswordCredential owns principalId, canonical email, sensitive password hash,
optional verifiedAtMs, passwordVersion, createdAtMs and changedAtMs. Human principals
only. Times use 0..253402300799999, versions 1..2147483647 with checked increments.
changedAt >= createdAt, verification time when present >= createdAt. Restore validates
without resetting history; optional timestamp 0 is present, not absent. AuthState
owns principalId and positive authEpoch with the same version ceiling. Password
replacement and security-wide revocation increment authEpoch; a hash-only re-encode
of an unchanged password uses guarded storage update without revoking sessions.

## Tokens, sessions and challenges

A05 — Session IDs, principal IDs and work IDs are public identifiers, never secrets.
Opaque tokens use 32 independent CSPRNG bytes encoded as canonical unpadded
base64url (43 characters); strict decode/re-encode equality, no whitespace. Storage
uses SHA-256 over UTF-8 purpose + one zero byte + decoded token bytes. Purpose is
exactly session, email_verification, password_reset or websocket_upgrade.
Entropy failure refuses issuance; no UUID, timestamp, PRNG or fallback token.
Raw tokens and their digests are excluded from generic logs and events. Token
generation/disclosure is explicit and returns a secret wrapper; domain code receives
already validated digests and explicit time/IDs.

A06 — Session owns sessionId, principalId, tokenDigest, authEpoch, issuedAtMs,
lastSeenAtMs, absoluteExpiresAtMs, idleExpiresAtMs and optional revokedAtMs.
Snapshots are owned. Issue requires absolute/idle deadlines strictly after issuedAt,
idle <= absolute, lastSeen=issuedAt, no revocation and positive authEpoch.
Restore validates all times and lastSeen <= idle <= absolute; revokedAt when present
is >= issuedAt. Default absolute lifetime 12 hours and idle lifetime 30 minutes;
these are configurable product defaults, not an assurance-level compliance claim.

A07 — A session is usable only if not revoked, now >= lastSeen, now < BOTH deadlines,
the referenced principal is active, the credential is verified and current authEpoch
matches. Equality at either deadline is expired. Successful activity advances lastSeen
and idle expiry to min(now + idleTTL, absolute expiry), with checked arithmetic;
absolute expiry never slides. Activity cannot clear revocation or revive an expired
session. Explicit revoke is idempotent and preserves the first revocation time.
A pure time check does not persist a terminal fact: the storage operation must latch
observed expiry/revocation and must refuse backward time relative to stored activity.

A08 — Every login issues a fresh token/session; a client-supplied or pre-login token
is never promoted. The baseline has no refresh token, JWT or automatic rotation
protocol: expiry requires login. Resolution reads authoritative state without a
positive auth cache in the first slice. Logout revokes one session; logout-all
increments authEpoch. Password change/reset and principal suspension invalidate all
sessions. Reactivating a principal cannot revive them. A revocation committed before
a new auth check is observed by that check. Already-admitted work requires its own
transactional authorization check when stronger guarantees are necessary.

A09 — Challenge owns challengeId, principalId, purpose, tokenDigest,
passwordVersion, issuedAtMs, expiresAtMs and optional consumedAtMs/invalidatedAtMs.
Purpose is email_verification or password_reset; no session token can substitute.
Lifetimes: verification 24 hours, reset 15 minutes, issued < expires, same bounded
time range. Valid consumption requires matching purpose/version, unconsumed and non-invalidated state,
issued <= now < expires. ConsumedAt=0 is representable. Reuse refuses; concurrent
consumers must have exactly one committed winner. Issuing a replacement invalidates
the previous outstanding challenge of that purpose atomically. Consumed/invalidated
timestamps, when present, are bounded and no earlier than issuedAt; neither is
cleared by restoration or another transition.

A10 — Email verification consumes a challenge only with proof of the current
password. This prevents an attacker pre-registering a victim's email/password and
later acquiring access when the victim merely clicks a mail link. Recovery proves
mailbox possession and replaces the password; it can establish email verification
in that same transaction. Neither verification nor recovery automatically logs in.
A verified email is mailbox control evidence, not proof of a real-world identity.

## Application ports and transaction guarantees

A11 — Application consumers own narrow PasswordHasher, TokenCodec, Clock, IDSource,
AuthStore, AttemptLimiter and MailDelivery capabilities. No crypto/DB/framework SDK
types cross these APIs. Store operations return explicit absent/refused/failed/
uncertain outcomes; they do not expose a transaction handle or generic repository.
Authenticate returns a safe AuthenticatedPrincipal containing principal/session IDs
and admitted epoch; email, hash and token are not an authorization context.

A12 — Register validates human identity, canonical email and password policy, hashes
outside a DB transaction, then atomically inserts principal, AuthState, credential,
verification challenge and safe registration outbox fact. A duplicate canonical email
does not replace a password, profile or challenge. It has the same public accepted
response as a new registration. No session is issued. A database error or uncertain
commit remains an operational failure, not a duplicate or a claimed rollback.

A13 — Login reads a credential snapshot, performs bounded verification outside the
transaction, then atomically rechecks active/verified state, passwordVersion and
authEpoch before storing a new session and login fact. A concurrent password change,
suspension or revocation prevents issuance from the stale snapshot. Wrong credentials
do not create a session. Never hold a DB row lock while running Argon2 or sending mail.

A14 — Verify/reset consumes the challenge and applies its effect in one transaction
with its outbox fact. Password reset replaces hash, increments passwordVersion and
authEpoch, sets verifiedAt when needed, and invalidates outstanding challenges.
Password change requires an authenticated session plus current-password proof and
the same version/epoch recheck; it invalidates sessions/challenges atomically.
Suspension updates principal state/version and authEpoch with its event atomically.
A statement failure rolls back the entire operation. Lost commit acknowledgement
stays uncertain; never automatically replay a one-use credential command.

A15 — MailDelivery is an explicit post-commit, bounded best-effort effect in this
baseline. Challenge tokens are persisted only as digests; raw token lives long enough
to construct its mail then is released. A crash or SMTP failure may leave a durable
challenge without a delivered message: log a safe outcome, and support a rate-limited
resend with a fresh challenge. Generic accepted means the request was handled, not
that mail arrived. An unknown commit must not send a token or claim delivery.
Durable mail retries would require a separate protected delivery store and a new
secret-retention decision; never put recovery secrets on the generic outbox/NATS bus.

A16 — Rate limits apply before expensive hashing and before mail issuance, per
trusted source network key and canonical login/session key plus a global concurrency
bound. Root defines trusted proxies; forwarding headers are not inherently trusted.
Use keyed digests for private login rate-limit keys, never raw email in Redis keys
or telemetry. Multi-process admission needs an atomic shared adapter. A process-only
counter is a test adapter, not distributed protection. Limiter failure refuses auth
admission with an operational failure; no silent fail-open or permanent account lock.
Budgets/configuration and test vectors must be specified with that adapter.

## Transport, observability and consumers

A17 — Browser cookie, origin, CSRF and route contracts are specified in AUTHENTICATION.md.
HTTP obtains auth evidence from the identity capability and maps safe failures;
it never constructs authority from caller principal/actor headers. Logout remains
idempotent for a missing/expired session but still enforces browser origin/CSRF rules.
Session/secret responses are no-store. Conflicting or duplicate credentials refuse.

A18 — WebSocket admission requires cookie resolution, strict allowed Origin and a
single-use session-bound upgrade ticket (30 seconds, separate purpose/digest).
Ticket issuance is CSRF-protected; its consumption and session validity are checked
together. Root owns auth checks before protected message handling and outbound
delivery and a maximum 30-second idle recheck interval. Expired/revoked sessions
close the connection; resource authorization remains an application responsibility.
A revocation notification can accelerate closure but is not the authority.

A19 — Provenance receives only established actor attribution: human -> user actor,
service executor retained. Unknown login attempts are anonymous even when an email
is supplied. Correlation headers convey no identity/tenant/delegation. Root owns the
translation; shared provenance and identity never import each other as peer domains.

A20 — Safe event types include identity.principal.registered.v1,
identity.email.verified.v1, identity.session.created.v1,
identity.session.revoked.v1, identity.sessions.revoked.v1,
identity.password.changed.v1 and identity.principal.suspended.v1.
Each committed mutation records its corresponding event(s) atomically. Payloads
carry stable subject IDs, reason/outcome enums and producer work; no email/name,
password, PHC hash, raw token, digest, cookie or Authorization header.
Audit receives an audit-owned translation at root. Broker publication does not mean
audit visibility; deduplication is per consumer with audit effects in the same DB tx.

A21 — Denied attempts do not imply a state-changing outbox event. Record bounded
auth outcome metrics and safe logs; a separate durable denial-ingestion policy is
required before claiming complete security audit coverage. Successful auth mutations
require outbox insertion, so outbox storage failure refuses the mutation. Transport/
collector/SMTP failure after commit cannot roll back identity state.

A22 — Failure vocabulary: Invalid identity.email_invalid / identity.password_invalid /
identity.token_invalid / identity.session_invalid / identity.challenge_invalid;
Unauthenticated identity.credentials_rejected / identity.session_rejected /
identity.challenge_rejected; Conflict identity.version_conflict;
RateLimited identity.auth_rate_limited; Internal identity.credential_corrupt;
Unavailable identity.auth_dependency_failed. Preserve shared Timeout/Canceled and
database.commit_uncertain meanings. Public login/challenge refusals do not disclose
which account field or proof failed; logs must not accidentally reveal it.

A23 — Pure constructors/restoration/transition tests use explicit clocks, IDs,
digests and snapshots. Shared fixtures cover Unicode normalization, deadline equality,
optional epoch-zero timestamps, type forgery/zero values, purpose confusion, checked
overflow and owned snapshots. Fake application tests distinguish mismatch, absent,
dependency failure and uncertain commit. Real adapters must prove concurrency,
rollback, timing/admission behavior and supported secret presentation paths.

A24 — Acceptance requires the complete workflow in AUTHENTICATION.md, not just leaf
tests. The first slice does not claim MFA, assurance-level certification, federated
identity, native bearer clients, device/IP binding, durable mail delivery or
retroactive cancellation of already-authorized work.

## Source basis

Reviewed 2026-09-12. Product defaults above remain explicit blueprint choices.
NIST supports long passwords without composition rules and NFC handling; no NIST
compliance is claimed: [SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html).
The selected Argon2id minimum and salted storage follow
[OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
Opaque credentials, expiry and cookie protections draw on
[OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
Single-use recovery, generic responses and avoiding automatic login follow
[OWASP recovery guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
CSRF is an independent boundary:
[OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).
