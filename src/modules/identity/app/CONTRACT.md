# Identity application operations contract

**Stage:** implemented and mutation-checked in every build on 2026-09-12, against fakes. These operations implement A11–A16 and A20–A22 of the identity
authentication contract against consumer-owned ports. Stage 4 verifies them with
fakes only; the transaction, lock and concurrency promises named for each store
port are stage 5 obligations of the PostgreSQL adapter, not claims made here.
No HTTP, cookie, CSRF, mail transport, rate-limit adapter or database code exists
in this layer, and no ORM, HTTP framework or crypto SDK type crosses its APIs.

## Inputs every operation shares

U01 — An operation receives the caller's established provenance work context and
uses it only as the producer of its outbox events. It never constructs an actor:
an unknown login attempt stays whatever the caller established (anonymous at the
HTTP boundary per A19). Time comes from the Clock port before any domain value is built (after admission is acceptable) and is passed explicitly to domain values; IDs come from the IDSource
port. A Clock reading outside the common time range or an IDSource failure is
Unavailable `identity.auth_dependency_failed`.

U02 — Product defaults are constructor configuration validated once: session
absolute lifetime 12 h and idle lifetime 30 min; verification challenge 24 h;
reset challenge 15 min. Zero, negative or out-of-range values are Invalid
`identity.auth_configuration` at construction.

U03 — Failure vocabulary follows A22. Port failures pass through with their
classification preserved; the application never converts a dependency failure,
a Timeout, a Canceled or a `database.commit_uncertain` outcome into a domain
refusal or a success. An uncertain commit is returned as-is, and no post-commit
effect (mail) runs after it.

## Ports, declared by their consumer

Each port returns values for expected outcomes and a classified failure only for
dependency problems. Fakes in the executable specs cover every row.

| Port | Operation | Values | Failure meaning |
| --- | --- | --- | --- |
| Clock | now | wall time | out of range → U01 |
| IDSource | new ID | ID | generator refusal → U01 |
| PasswordHasher | hash(NewPassword) → hash text; verify(PasswordInput, hash) → matched true/false; verifyAbsent(PasswordInput) → false | mismatch is a value | admission/corruption failures pass through |
| TokenCodec | issue(purpose) → secret + digest; digest(purpose, secret) → digest | canonical-form refusal is Invalid `identity.token_invalid` | entropy failure passes through |
| EnrollmentPolicy | checkBlocklist(NewPassword) → allowed true/false | refused is a value | source failure passes through as Unavailable |
| AttemptLimiter | admit(operation, subject key, source key) → permitted, or refused with retry-after ms | refusal is a value | limiter failure refuses admission (A16) |
| MailDelivery | sendVerification(Email, secret token, expiresAt); sendReset(...) → delivered true/false | failure is a value reported privately | none: mail never fails the command |
| RegisterStore | register(record) → created \| duplicate_email | private outcome | any store failure |
| CredentialReader | findByEmail(Email) → found record \| absent | absent is a value | read failure |
| LoginStore | commitLogin(record) → committed \| stale | stale = principal inactive, unverified, version or epoch changed | store failure |
| SessionResolver | resolve(digest, now, idleTTL) → admitted(principal, session, epoch) \| rejected \| absent | both refusals are values | store failure |
| SessionRevoker | revokeSession(sessionID, principalID, now, event) → revoked \| already_inactive \| absent | idempotent | store failure |
| EpochStore | revokeAll(principalID, expectedEpoch, now, event) → committed \| stale | | store failure |
| ChallengeReader | findByDigest(purpose, digest) → found(challenge, credential, principal status, epoch) \| absent | | read failure |
| ChallengeStore | issueChallenge(record) → issued \| stale | invalidates the previous outstanding challenge of that purpose atomically | store failure |
| VerifyStore | verifyEmail(record) → committed \| stale | rechecks unconsumed challenge and version in the transaction | store failure |
| PasswordStore | changePassword(record) → committed \| stale; resetPassword(record) → committed \| stale | version/epoch guard inside the transaction | store failure |
| UpgradeTicketStore | issueUpgradeTicket(record) → committed \| stale; consumeUpgradeTicket(digest, now) → admitted principal/session/epoch \| absent | one-use ticket bound to the live session and auth epoch | store failure |

Store records carry validated domain snapshots, the expected versions/epoch that
the operation actually verified, explicit times and the safe outbox envelopes to
enqueue in the same transaction (A21). The AttemptLimiter subject key is the canonical email for email-keyed operations
(so Email parsing precedes admission), the hex of the token digest for token-keyed
operations (verify and reset; the source key is empty when the input carries
none), and the principal ID for authenticated ones; the limiter adapter owns keyed
digesting (A16), so the application hands it a private secret string, never a
hashed key of its own. A rate-limit refusal is RateLimited
`identity.auth_rate_limited` and may expose `retry_after_ms` as a public field.
Each build supplies one store adapter that every operation narrows to the subset
it consumes (Go per-operation interfaces behind a Deps struct, Rust one generic
bounded by the consumed traits, TypeScript an intersection type narrowed per
command); this is not a generic repository.

## Operations

U04 — Register(email, password, source) → accepted. Steps: parse Email; limiter admit
(`register`, canonical email, source); parse NewPassword; blocklist check (refused
→ Invalid `identity.password_invalid`, field `password=blocklisted`); hash outside any transaction;
new IDs and time; build human Principal (display name is the email's local part
truncated to the principal limit until a profile exists), AuthState epoch 1,
CredentialSnapshot with absent verification and passwordVersion 1, an
email_verification Challenge with a fresh token, and the
`identity.principal.registered.v1` envelope; register store. `created` and
`duplicate_email` both return accepted; only `created` sends the verification mail
post-commit. Duplicate never replaces the existing password, challenge or principal.
The private result names created/duplicate and whether mail was delivered.

U05 — RequestVerification(email, source) → accepted. Limiter admit
(`verification_request`); findByEmail; absent, already verified, or a principal that is not active →
accepted with no mail and no write; otherwise issue a replacement email_verification challenge
(fresh ID, token, times; expected password version from the read), then send mail
post-commit. `stale` → accepted with no mail (the state moved; the client retries). The
private outcome is issued, absent, already_verified or stale.

U06 — VerifyEmail(token, password) → verified. Limiter admit (`verify`, token
digest as subject); digest the token with purpose email_verification (malformed → the same
`identity.challenge_rejected`); findByDigest; absent → Unauthenticated `identity.challenge_rejected`; verify the
password against the found credential outside the transaction (mismatch → the same
`identity.challenge_rejected`; A10); evaluate the pure Challenge consume at now
with the credential's current password version (refusal → `challenge_rejected`);
build `identity.email.verified.v1`; verify store with expected versions; `stale` →
`challenge_rejected`. Already verified credentials still consume the challenge and
commit idempotently. No session is issued.

U07 — Login(email, password, source) → issued session. Limiter admit (`login`,
email, source); parse Email and login PasswordInput (malformed → Invalid, which
is a request-shape refusal, not a credential refusal); findByEmail; absent →
verifyAbsent then Unauthenticated `identity.credentials_rejected`; found →
verify; mismatch, unverified email or suspended principal → the same
`credentials_rejected` after the verification work; issue a session token,
build the Session (issued now, absolute and idle deadlines from configuration,
the read epoch) and `identity.session.created.v1`; commitLogin with the verified
password version and epoch; `stale` → `credentials_rejected`. The result carries
the session ID, the secret token, both deadlines and the safe principal projection.
A client-supplied token is never promoted (A08).

U08 — Authenticate(token) → authenticated principal. Digest the token with purpose
session (Invalid form → Unauthenticated `identity.session_rejected`, so a malformed
cookie is not distinguishable from a stale one); resolve with now and the idle TTL;
absent or rejected → `identity.session_rejected`; admitted → AuthenticatedPrincipal
{principal ID, session ID, admitted epoch}. The resolver owns the transactional
recheck of principal status, credential verification, epoch and the idle extension
write; the application makes no positive-cache claim.

U09 — Logout(authenticated principal) → done. revokeSession with the caller's
session and principal IDs, now, and `identity.session.revoked.v1` (reason logout);
`already_inactive` and `absent` are also done (idempotent, no event).

U10 — LogoutAll(authenticated principal) → done. revokeAll with the admitted epoch
and `identity.sessions.revoked.v1` (reason logout_all); `stale` → Conflict
`identity.version_conflict`.

U11 — ChangePassword(authenticated principal, current password, new password) →
done. Limiter admit (`password_change`, principal ID); findByEmail is not
available (no email is supplied), so the port is a credential read by principal
ID: extend CredentialReader with findByPrincipal(principalID) → found | absent;
absent → Unauthenticated `identity.session_rejected`; verify current password
(mismatch → Unauthenticated `identity.credentials_rejected`); parse NewPassword
and blocklist check; hash; build `identity.password.changed.v1` (reason change,
next version) and `identity.sessions.revoked.v1` (reason password_change);
changePassword with expected version and epoch; `stale` → Conflict
`identity.version_conflict`. All sessions, including the caller's, are invalidated
by the epoch increment; the result says so.

U12 — RequestReset(email, source) → accepted. As U05 with purpose password_reset
and the reset mail; unverified credentials may still request a reset (recovery proves mailbox
control, A10); a principal that is not active receives no reset challenge and no
mail, with the same accepted response.

U13 — ResetPassword(token, new password) → done. Limiter admit (`reset`, token
digest); digest with purpose password_reset (malformed → `identity.challenge_rejected`);
findByDigest; absent → Unauthenticated
`identity.challenge_rejected`; parse NewPassword and blocklist; evaluate the pure
consume; hash; build `identity.password.changed.v1` (reason reset) and
`identity.sessions.revoked.v1` (reason password_reset); resetPassword with
expected version and epoch and `setVerified` true when the credential was
unverified; `stale` → `challenge_rejected`. No session is issued.

U17 — Principal status is enforced by the store recheck, which reports an inactive
principal as `stale` in every mutation (A13/A14), so refusing a suspended principal
before the store call is an optional application pre-check. The builds differ:
Rust pre-checks in VerifyEmail and ResetPassword, Go in ChangePassword, and the
refusal type is the same either way. RequestVerification and RequestReset refuse mail to a principal that is not
active before any write, and still answer accepted, so suspension is not
disclosed (decided 2026-09-12).

U18 — WebSocketTicket(authenticated principal) issues a 32-byte opaque token with
the `websocket_upgrade` purpose and a maximum 30-second lifetime. The store
persists only its digest after rechecking the active, verified session and the
expected auth epoch. The transport carries the secret in the private
`n2f.ticket.<ticket>` subprotocol alongside `n2f.v1`; the store consumes it once,
atomically rechecking session validity, principal status and epoch. No ticket
secret, digest or cookie enters an event, log, audit record or URL.

## Safe events

U14 — Payloads are JSON objects with only stable IDs, enums and versions:
`identity.principal.registered.v1` {principal_id, kind, origin:"self_registration"};
`identity.email.verified.v1` {principal_id, challenge_id};
`identity.session.created.v1` {principal_id, session_id, auth_epoch};
`identity.session.revoked.v1` {principal_id, session_id, reason};
`identity.sessions.revoked.v1` {principal_id, auth_epoch, reason};
`identity.password.changed.v1` {principal_id, password_version, reason}.
No email, display name, hash, token, digest or source key appears in any payload.
Each envelope takes a fresh ID from IDSource, the operation's time and the caller's
work context. Refused attempts emit no event (A21).

## Verification

U15 — Executable specs use fakes for every port and a fixed clock/ID sequence. They
distinguish mismatch, absent, dependency failure, uncertain commit and stale for
each operation; prove no mail after uncertain or stale outcomes; prove duplicate
registration performs no replacement; prove verifyAbsent runs for unknown logins;
prove events carry no private data; and prove the caller's token is never
promoted. Fakes record calls in order so the spec can assert that hashing happens
before the store call and mail after it.

U16 — Selected mutations: enumeration leak (absent login skips verifyAbsent),
duplicate replaces credential, mail after uncertain commit, verification without
password proof, stale commit treated as success, and private data in an event.

## Native shapes

Go (`internal/identity/app/command`, `internal/identity/app/query`): one struct
per operation constructed with its ports and `Config`; `Register(ctx, RegisterInput)
(RegisterResult, error)` and so on; port interfaces declared in the command/query
package that consumes them, returning `(value, error)`; outcomes are small enums;
`AuthenticatedPrincipal` lives in `app/query` and `command` imports it for U09–U11.
Events are built through a package
helper using `pkg/events.New` with the caller's `provenance.WorkContext`.

Rust (`domains::identity::app::{command, query}`): async traits with
`Send + Sync` bounds for ports, one struct per operation generic over its ports,
`Result<Outcome, Failure>` returns, `AuthenticatedPrincipal` in `app`; `query` reuses
`command`'s Clock and TokenCodec traits rather than redeclaring them. Neither
direction forms a cycle.

TypeScript (`modules/identity/app/command`, `modules/identity/app/query`): port
interfaces returning `Promise<Result<…, Failure>>`, one class per operation created
with its ports and config, `Result` outcomes as discriminated unions.
