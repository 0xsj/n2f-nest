# Authentication is an identity responsibility

**Origin:** the user clarified on 2026-09-12 that authentication is required out of
the box. The prior principal-only stage was a valid leaf, but its plan incorrectly
made credentials and sessions sound like an optional later feature.

Identity owns the principal and the proof/lifecycle that makes an actor authenticated.
An account/profile can later own person-facing information; neither is a prerequisite
for password credentials or sessions. The current principal display name stays a
label rather than forcing a profile extraction before auth.

The working baseline uses server-side opaque sessions. The tradeoff is an
authoritative state lookup for straightforward revocation. A session ID is a public
reference; a 32-byte random token is the secret. UUIDv7 supplies identifiers, not
authentication entropy. Shared secret wrappers redact presentation but do not
hash passwords, hide deliberately revealed values or wipe memory.

Two effects cross different consistency boundaries. Login verifies an expensive
password outside a transaction, then must recheck credential version and auth epoch
inside the session-creation transaction. Reset consumes its challenge, replaces the
password and invalidates sessions in one transaction. An in-memory version guard
or a successful hash comparison alone establishes neither guarantee.

A verification link by itself must not activate credentials that an attacker
pre-registered using a victim's email. The planned verification requires current
password proof; recovery instead proves mailbox access and replaces the credential.

Mail introduces a deliberate delivery gap. Storing only a challenge digest means a
crash after commit cannot reconstruct the mail token. The initial policy is bounded
post-commit delivery plus resend, not durable mail retry. Adding recoverable encrypted
mail jobs later would require an explicit secret-retention and key-ownership decision.

**Limits:** these are design decisions and review findings. The pure auth leaves
are now implemented, with six selected mutations caught per build (see the
[language walkthrough](auth-leaves-walkthrough.md)); crypto, database, browser,
Mailpit and WebSocket verification remain future work. Leaf evidence says nothing
about transaction, hashing or transport behavior.

**Related:** [authentication plan](../../../../../../AUTHENTICATION.md)
and [decision 0011](../../../../../../decisions/0011-identity-includes-credentials-and-revocable-sessions.md)
link the local behavior contract, native API map and logical schema.
