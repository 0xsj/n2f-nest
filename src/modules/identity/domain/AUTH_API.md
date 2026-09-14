# Authentication leaf and capability map

**Stage:** leaves and crypto adapters available. The first-leaf shapes below are exported and tested; PasswordHasher and TokenCodec are implemented as identity-owned adapters with
local contracts; the application-owned capabilities below are declared as ports by
the operations in [the application contract](../app/CONTRACT.md) and verified with
fakes; concrete AuthStore, AttemptLimiter, EnrollmentPolicy, MailDelivery and
upgrade-ticket adapters are implemented in the current composition. AUTH_CONTRACT.md
is the behavior authority.

## First leaves, in dependency order

| Owner/file stem | Responsibility | Native shape |
| --- | --- | --- |
| email | Canonical login key, strict parse, explicit private projection | Go Email; Rust Email; TypeScript Email |
| password | Validated normalized secret, enrollment policy separate from login input | NewPassword / PasswordInput |
| token | Closed purpose, validated 32-byte digest, redacting token disclosure | TokenPurpose, TokenDigest, IssuedToken |
| credential | Validated snapshot/restoration, passwordVersion and email verification | PasswordCredential, CredentialSnapshot |
| auth_state | Principal security epoch and checked invalidation | AuthState |
| session | Issue/restore/check/touch/revoke using explicit time and limits | Session, SessionSnapshot |
| challenge | Issue/restore/consume/invalidate with purpose/version guards | Challenge, ChallengeSnapshot |
| upgrade_ticket | Short-lived session-bound single-use WebSocket admission | UpgradeTicket, UpgradeTicketSnapshot |

Constructors take explicit IDs/time/digests. No global clock, random generation,
hashing, logging or database calls in these leaves. Session.Check evaluates session
facts; application/storage adds active principal, verified credential and epoch
checks. A local Challenge.Consume returns a changed value; only storage can guarantee
single-use across callers. InvalidatedAtMs is an explicit optional timestamp and is
checked alongside ConsumedAtMs, using the same bounds/presence rules.

### Idiomatic forms

Go: ParseEmail(string) (Email, error), RestoreSession(SessionSnapshot) (Session, error),
(Session).Check(nowMS int64) error, (Session).Touch(nowMS, idleTTLMS int64)
(Session, error). Use private fields, value-returning transitions and shared errors;
validate usable zero values at exported operations. Fixed digest arrays copy by value.

Rust: Email::parse(&str) -> Result<Email, Failure>, Session::restore(SessionSnapshot)
-> Result<Self, Failure>, check(&self, now_ms: i64) -> Result<(), Failure>,
touch(&self, now_ms: i64, idle_ttl_ms: i64) -> Result<Self, Failure>.
Private fields and closed enums prevent some invalid states. Do not derive Debug
for a struct containing unredacted password/hash/token data. Option<i64> represents
absence; u32 still obeys the common signed-32-bit epoch/version ceiling.

TypeScript: Email.parse(input: string): Result<Email, Failure>,
Session.restore(snapshot: SessionSnapshot): Result<Session, Failure>,
check(nowMs: number): Result<void, Failure>,
touch(nowMs: number, idleTtlMs: number): Result<Session, Failure>.
Use runtime-private state, runtime validation despite brands/unions, safe integers,
and defensive copies of Uint8Array digests. TypeScript private constructors alone
are insufficient at a JavaScript boundary. Optional timestamps use an explicit
undefined convention internally and null only at a deliberately decoded SQL boundary.

## Application-owned capabilities

Use native cancellation/deadline conventions. Every effect below has a bounded
operation budget and returns shared classified failures as distinct from its values.

| Capability | Intended operations / values |
| --- | --- |
| PasswordHasher | Hash(NewPassword) -> PasswordHash; Verify(PasswordInput, PasswordHash) -> Match or Mismatch; VerifyAbsent(PasswordInput) -> Mismatch; NeedsRehash(Hash) -> bool. Implemented: [contract](../password-hash/CONTRACT.md) |
| TokenCodec | Issue(Purpose) -> IssuedToken(secret, digest); Digest(Purpose, secret) -> TokenDigest. Implemented: [contract](../token-codec/CONTRACT.md) |
| Clock / IDSource | Existing narrow wall-clock and ID generation capabilities |
| EnrollmentPolicy | CheckBlocklist(NewPassword) -> allowed/refused; source failure distinct |
| AttemptLimiter | Admit(operation, private subject key, trusted source key) -> permit/refusal/retry delay |
| MailDelivery | SendVerification / SendReset(Email, secret token, expiry) -> delivered-to-SMTP or failure |
| AuthStore | Register; FindCredential; CommitLogin; ResolveSession; RevokeSession; RevokeAll; IssueChallenge; VerifyEmail; ChangePassword; ResetPassword; Suspend; Issue/ConsumeUpgradeTicket |

AuthStore is a list of operation-specific contracts, not a demand for one giant
interface. Declare each subset beside the command/query that consumes it. Input
records carry validated domain values, expected versions/epoch, explicit time and
safe event work. Concrete operations encapsulate the complete transaction promised
in AUTH_SCHEMA.md. No transaction object or third-party connection crosses the port.

FindCredential returns absent separately from a read failure. Verify returns mismatch
separately from a hash failure. CommitLogin takes the credential version/epoch that
was actually verified. Register returns created or duplicate privately; transport
projects the same public accepted response. ResolveSession returns an admission
projection, never the raw SessionSnapshot or credential record.

Successful issuance discloses the token only to its named transport/mail consumer.
Persistence receives digests. Neither root log projections nor audit translators
receive raw tokens. A store error after attempted commit retains uncertainty.

## Executable specification map

| Contract | Required scenarios before implementation |
| --- | --- |
| A01–A04 | Email canonical collision / plus preservation / malformed inputs; password NFC equivalents, scalar limits, preserved spaces, blocklist absence/failure; restore history and zero-time presence |
| A05 | Known digest vectors for each purpose, strict base64url tail bits, entropy failure, no UUID substitution, redacted formatting/JSON/inspection |
| A06–A08 | Issue bounds; exact idle/absolute expiry; idle cap; backward time; overflow; first revocation time retained; inactive/unverified/epoch mismatch application guards |
| A09–A10 | Wrong purpose/version, consumed/invalidated/expired challenge, expiry equality; verification without current password refused |
| A11–A16 | Fake port failure vs mismatch vs absence; stale verified snapshot; duplicate registration no replacement; mail failure after commit; hash/limiter admission exhaustion |
| A12–A14 | Real rollback after each write; concurrent canonical collision; concurrent challenge consumers; password change/login and logout/touch races; uncertain commit |
| A17–A23 | Real browser origin/CSRF/cookie checks, body bounds, no-store, attribution spoofing, WebSocket revocation and outbox/audit deduplication |

Tests are authored with implementation visibility unless an independent workflow
actually establishes otherwise. Selected mutation candidates are tests of named
faults, not an exhaustive coverage score. No entries above count as executed tests.
