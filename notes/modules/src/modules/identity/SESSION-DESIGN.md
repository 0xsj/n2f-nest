# Identity session and authentication design

Authentication verifies an active Credential and creates a revocable Session;
the session domain owns access lifetime while token material remains behind
application and infrastructure ports.

## Origin

This slice follows Identity lifecycle, Credential metadata, registration and
email verification. It introduces the first authenticated continuity needed by
the frontend:

```text
email + password
→ credential lookup
→ password verification
→ active Identity check
→ Session creation
→ opaque session token returned to transport
```

The use case is framework-free. It does not decide whether the token is placed
in a cookie, bearer header or another transport mechanism.

## Session language

A Session is temporary authenticated continuity for an Identity. It contains:

- session ID
- Identity ID
- creation time
- expiry time
- active or revoked status
- optional revocation time

The Session entity does not contain the raw session token or token digest. The
token is an authentication secret, not domain state.

Expiry is evaluated at the point of use. An active Session can be expired by
time without being rewritten first; `assertUsable(at)` rejects it at or after
the expiry instant. Revocation is explicit and produces a new revoked Session.

## Session invariants

- expiry must be after creation
- session dates must be valid
- an active session is usable only before expiry
- a revoked session is never usable again
- revocation cannot precede creation
- Session transitions are immutable
- disabled or suspended Identities cannot reach session creation

The last rule is enforced by the authentication application workflow using the
Identity status. The Session entity itself remains reusable for other trusted
creation paths without importing Identity policy.

## Authentication command

`AuthenticateIdentity` performs this sequence:

1. normalize the email login identifier
2. load the Identity, Credential and stored password hash
3. require an active Identity and active Credential
4. verify the supplied password through `PasswordVerifier`
5. obtain the session expiry from `SessionPolicy`
6. create a Session
7. issue a token and private digest through `SessionTokenIssuer`
8. create `identity.session.created.v1`
9. atomically persist the Session, token digest and outbox event
10. return the Identity ID, Session ID, redacted token wrapper and expiry

Unknown, inactive and invalid credentials collapse to the same
`identity.invalid_credentials` refusal so the application does not disclose
whether an email is registered or inactive.

The current command does not emit a separate authentication-success event. A
successful session-created event represents both the authentication result and
the new authenticated continuity. Failed attempts are intentionally deferred
as a separate security-event and rate-limit policy.

## Logout and revocation

`RevokeSession` is the command-side logout capability. It resolves the session
through the same current-session reader, revokes an active Session and commits
`identity.session.revoked.v1` with the changed Session and outbox fact.

Logout is intentionally idempotent:

- a missing session returns success with `revoked: false`
- an already-revoked session returns success with `revoked: false`
- an active session returns `revoked: true` and produces one event

The no-op paths do not write or emit a duplicate event. This lets transport
adapters safely treat logout as successful even when a client has already
discarded, expired or previously revoked its session.

The revocation event contains the Identity ID, Session ID and resulting status;
it never contains the session token or digest. Audit can later record the
actual state change while ignoring idempotent no-op requests unless a separate
security-access policy chooses to retain them.

## Token boundary

The application owns two token ports:

```text
PasswordVerifier
  submitted password + stored password hash → valid / invalid

SessionTokenIssuer
  → raw token + storage digest
```

The raw token is returned only as `SecretString` to the transport-facing
application result. The writer receives only the digest for persistence. The
event payload and provenance envelope never contain either value.

This allows the eventual adapter to choose opaque random tokens, a keyed
digest strategy or another implementation without changing the Session entity
or command contract.

## Session policy

`SessionPolicy` decides the expiry from the explicit creation time. The command
does not hard-code a duration and the domain does not read configuration.

This leaves room for different policy later:

- browser session versus remembered session
- fan versus organization-user policy
- device or risk-based expiry
- forced short-lived sessions during recovery

The first concrete policy will be composed at the infrastructure/configuration
boundary.

## Provenance and Audit

The authentication command receives a `WorkContext` whose initiator is usually
anonymous because the request has not yet authenticated. The event envelope
retains that original operation lineage, currently `identity.authenticate`.

The event payload identifies the resulting Identity, Credential and Session.
This lets Audit record the successful authentication/session fact without
pretending the anonymous request was authenticated before verification.

The next request made with the session can establish a new provenance context
whose actor is the authenticated Identity. Provenance is therefore a sequence
of operation contexts, not a mutable property copied into the Session entity.

Audit is not being given a domain model in this slice. The event envelope and
shared provenance values are sufficient until we define the first Audit
consumer/projector and its durable record invariants. At that point Audit will
own its own domain record and projection ports; it will not duplicate the
Identity or Session entities.

## Atomic persistence boundary

`SessionWriter` commits:

- Session state
- token digest
- session-created outbox event

The command does not call a publisher directly. This preserves the same
state-and-outbox atomicity used by registration and verification. Delivery and
consumer receipts remain adapter responsibilities.

## Testing approach

Session domain tests cover creation, expiry, revocation, immutable transitions
and rejection after revocation.

Authentication application tests cover:

- successful credential verification and Session creation
- returned secret token versus persisted digest separation
- provenance-bearing event creation
- absence of token material from the event
- a single unauthenticated result for unknown credentials

Password verifier, token issuer and policy tests remain application/infrastructure
concerns. The first PostgreSQL session writer, current-session reader and
revocation writer are now covered by adapter tests alongside the atomic outbox
ordering.

## Deliberately deferred

- session rotation
- multiple concurrent sessions and device management
- cookie or bearer-token transport
- password login throttling and failed-attempt events
- Audit durable record schema and consumer idempotency

## Used in

- [`src/modules/identity/domain/session.ts`](../../../../../src/modules/identity/domain/session.ts)
- [`src/modules/identity/domain/session.spec.ts`](../../../../../src/modules/identity/domain/session.spec.ts)
- [`src/modules/identity/app/commands/authenticate-identity.ts`](../../../../../src/modules/identity/app/commands/authenticate-identity.ts)
- [`src/modules/identity/app/commands/authenticate-identity.spec.ts`](../../../../../src/modules/identity/app/commands/authenticate-identity.spec.ts)
- [`src/modules/identity/app/ports/credential-authenticator-reader.ts`](../../../../../src/modules/identity/app/ports/credential-authenticator-reader.ts)
- [`src/modules/identity/app/ports/password-verifier.ts`](../../../../../src/modules/identity/app/ports/password-verifier.ts)
- [`src/modules/identity/app/ports/session-policy.ts`](../../../../../src/modules/identity/app/ports/session-policy.ts)
- [`src/modules/identity/app/ports/session-token-issuer.ts`](../../../../../src/modules/identity/app/ports/session-token-issuer.ts)
- [`src/modules/identity/app/ports/session-writer.ts`](../../../../../src/modules/identity/app/ports/session-writer.ts)
- [`src/modules/identity/app/commands/revoke-session.ts`](../../../../../src/modules/identity/app/commands/revoke-session.ts)
- [`src/modules/identity/app/commands/revoke-session.spec.ts`](../../../../../src/modules/identity/app/commands/revoke-session.spec.ts)
- [`src/modules/identity/app/ports/session-revocation-writer.ts`](../../../../../src/modules/identity/app/ports/session-revocation-writer.ts)

## Related

- [Identity module overview](README.md)
- [Identity domain design](DOMAIN-DESIGN.md)
- [Registration application design](APPLICATION-DESIGN.md)
- [Verification design](VERIFICATION-DESIGN.md)
- [Shared provenance notes](../../shared/provenance/README.md)
- [Shared events notes](../../shared/events/README.md)
- [Shared secret notes](../../shared/secret/README.md)
