# Authentication storage shape

**Stage:** logical schema for A01–A24; the identity migration and store implementing
it are specified in [the store contract](../infra/postgres/CONTRACT.md). Upgrade
tickets are migration version 5 and are issued and consumed through the same
session/epoch recheck boundary. All tables below are
identity-owned except the existing shared outbox. Concrete adapters own SQL and
restore through validated domain values. Root supplies one complete migration ledger.

| Record | Fields | Constraints |
| --- | --- | --- |
| Principal (existing value) | id, kind, displayName, status, createdAtMs, updatedAtMs, version | Nonzero UUID; I01–I07; auth enrollment creates human |
| AuthState | principalId, authEpoch | PK/FK principal; positive bounded epoch |
| PasswordCredential | principalId, canonicalEmail, passwordHash, verifiedAtMs?, passwordVersion, createdAtMs, changedAtMs | PK/FK principal; unique canonicalEmail; sensitive hash; verified absence explicit |
| Session | id, principalId, tokenDigest, authEpoch, issuedAtMs, lastSeenAtMs, absoluteExpiresAtMs, idleExpiresAtMs, revokedAtMs? | PK id; FK principal; unique 32-byte digest; A06 time checks |
| Challenge | id, principalId, purpose, tokenDigest, passwordVersion, issuedAtMs, expiresAtMs, consumedAtMs?, invalidatedAtMs? | PK id; FK credential; unique purpose+digest; A09; invalidate on replacement |
| UpgradeTicket | id, sessionId, tokenDigest, issuedAtMs, expiresAtMs, consumedAtMs? | PK id; FK session; unique digest; 30-second maximum lifetime |
| Outbox (existing) | envelope and delivery bookkeeping | Committed with each promised identity mutation |

Session and challenge UUIDs are references, not bearer credentials. Token digests
have a fixed binary storage representation; no plain token column. Password hash
is a redacting value in memory and sensitive PHC text at the persistence boundary.
Emails are private, though not authentication secrets.

Store timestamps as bounded integer Unix milliseconds for consistent cross-language
roundtrips; nullable timestamps must distinguish absent from 0. SQL CHECK constraints
duplicate critical domain bounds as corruption protection, not as a replacement
for domain validation. Enforce canonical-email uniqueness with explicit bytewise
semantics; do not rely on locale-dependent collation or implicit database lowercasing.

## Atomic commands

| Command | Single transaction contents |
| --- | --- |
| Register | Principal + AuthState + credential + verification challenge + registration event |
| Issue replacement challenge | Lock credential/auth state; invalidate previous outstanding purpose; insert new challenge |
| Verify email | Lock/recheck credential version; consume challenge; set verifiedAt; verification event |
| Login | Recheck principal/credential/epoch snapshot; insert session; session-created event |
| Logout | Revoke session if live; event only for an actual change |
| Logout-all | Increment authEpoch; sessions-revoked event |
| Change/reset password | Guard version/epoch; replace hash; increment passwordVersion and authEpoch; invalidate challenges; consume reset challenge if applicable; change event |
| Suspend | Guard principal version; change status; increment authEpoch; suspension event |
| Upgrade ticket | Issue against valid session; later consume once while rechecking session/epoch |

All auth writes and session admission coordinate through the principal AuthState
row. Establish one lock order: AuthState -> principal -> credential -> session or
challenge/ticket. Re-read preliminary lookups after locking. A preliminary hash
verification is not permission to skip this recheck. Use guarded updates and affected
row counts; no read-then-unconditional-write pattern.

Retaining expired/invalidated challenges supports replay refusal; outstanding
uniqueness uses explicit consumed/invalidated fields, not a partial-index predicate
involving the current time. Reissue invalidates even an already-expired unconsumed
row. Cleanup retention is a separate bounded worker policy.

Authentication resolution must not race a logout into a successful idle-extension
write. Lock/recheck within its storage operation. Already-admitted application work
is not canceled by this boundary; sensitive writes may need a transactional identity
eligibility guard supplied through the consuming module's port.

SMTP and password hashing occur outside transactions. Post-commit SMTP failure is
recoverable through resend; the outbox never contains the challenge secret.
