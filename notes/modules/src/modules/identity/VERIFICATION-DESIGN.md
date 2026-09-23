# Identity verification design

Verification proves control of an authentication channel and transitions an
Identity from pending verification to active without placing token material in
the domain or event stream.

## Origin

This slice follows the Identity lifecycle, Credential metadata and registration
command. It introduces two related but separate concepts:

- `VerificationChallenge` owns expiry and single-use lifecycle
- `VerifyIdentity` orchestrates token verification, Identity activation and
  atomic event recording

The token itself is deliberately handled by an application port. The domain
does not generate, hash, compare, deliver or reveal verification tokens.

## Challenge language

A verification challenge contains:

- challenge ID
- owning Identity ID
- purpose, currently `email_verification`
- issuance time
- expiration time
- issued or consumed status
- optional consumption time

Expiration is derived from `expiresAt`; it is not a third persistent status.
An issued challenge is usable only before its expiration instant. Consumption at
the exact expiration time is rejected.

The challenge is immutable. `consume(at)` returns a new consumed challenge and
leaves the original issued challenge unchanged.

## Challenge invariants

- issuance and expiration times must be valid dates
- expiration must be after issuance
- consumption cannot precede issuance
- an expired challenge cannot be consumed
- a consumed challenge cannot be consumed again
- token values and token digests are not challenge fields
- a challenge belongs to exactly one Identity

The challenge entity does not decide whether its owning Identity is still
pending. That check belongs to the `VerifyIdentity` workflow when it applies
the Identity transition.

## Token boundary

`VerificationTokenVerifier` is an application-owned outbound port:

```text
raw token + stored digest
→ verifier adapter
→ valid / invalid result
```

The adapter can use a cryptographic comparison or a future token strategy
without changing the challenge entity. The raw token is wrapped in
`SecretString` at the transport boundary and is never placed in a domain event,
log field or ordinary result.

The challenge reader returns the challenge together with its stored digest as a
short-lived application record. The digest is needed for verification, but it
does not become part of the domain object.

## VerifyIdentity command

The command performs this sequence:

1. load the challenge record
2. verify the supplied token through `VerificationTokenVerifier`
3. load the owning Identity
4. read one explicit current time
5. consume the challenge
6. verify the pending Identity
7. create `identity.verified.v1`
8. atomically commit the active Identity, consumed challenge and outbox event
9. return the Identity ID and active status

The writer boundary owns the transaction. The command does not publish an event
before the state transition is durable and does not attempt compensation after
the writer is called.

## Provenance and Audit

The command receives a trusted `WorkContext`. The event envelope preserves the
operation and attribution, currently `identity.verify`.

For a public verification link, the initiator remains anonymous. Possession of
the verification token proves channel control; it does not retroactively make
the pre-authentication request an authenticated actor.

The event payload contains only:

- `identity_id`
- `challenge_id`
- challenge purpose
- resulting Identity status

It excludes the raw token and stored token digest. Audit can use the envelope's
provenance and the payload's IDs without importing Identity internals.

## Port roles

- `IdentityReader` loads the domain Identity needed by the command.
- `VerificationChallengeReader` loads a challenge and its private digest.
- `VerificationTokenVerifier` compares token material without exposing the
  algorithm to the application.
- `VerificationWriter` atomically commits the changed Identity, consumed
  challenge and event.

These are outbound application ports. They are interfaces owned by the
application and implemented later by infrastructure. None exposes ORM rows,
database clients, HTTP requests or NATS subjects.

## Testing approach

Domain tests cover:

- challenge issuance
- valid consumption
- expiry at the boundary
- single-use enforcement
- invalid expiry configuration
- immutable state transition

Application tests use fakes to cover:

- successful activation and commit
- provenance-bearing event creation
- absence of token material from the event
- invalid token preventing any write

Database transaction, token-digest implementation and email delivery belong to
adapter tests and later integration tests.

## Deliberately deferred

- token generation and delivery
- resend and replacement policy
- rate limits and abuse detection
- email address ownership and deliverability
- verification-link transport shape
- whether other credential methods require different challenge purposes
- whether verification events are retained separately from Audit facts

## Used in

- [`src/modules/identity/domain/verification-challenge.ts`](../../../../../src/modules/identity/domain/verification-challenge.ts)
- [`src/modules/identity/domain/verification-challenge.spec.ts`](../../../../../src/modules/identity/domain/verification-challenge.spec.ts)
- [`src/modules/identity/app/commands/verify-identity.ts`](../../../../../src/modules/identity/app/commands/verify-identity.ts)
- [`src/modules/identity/app/commands/verify-identity.spec.ts`](../../../../../src/modules/identity/app/commands/verify-identity.spec.ts)
- [`src/modules/identity/app/ports/identity-reader.ts`](../../../../../src/modules/identity/app/ports/identity-reader.ts)
- [`src/modules/identity/app/ports/verification-challenge-reader.ts`](../../../../../src/modules/identity/app/ports/verification-challenge-reader.ts)
- [`src/modules/identity/app/ports/verification-token-verifier.ts`](../../../../../src/modules/identity/app/ports/verification-token-verifier.ts)
- [`src/modules/identity/app/ports/verification-writer.ts`](../../../../../src/modules/identity/app/ports/verification-writer.ts)

## Related

- [Identity module overview](README.md)
- [Identity domain design](DOMAIN-DESIGN.md)
- [Registration application design](APPLICATION-DESIGN.md)
- [Shared provenance notes](../../shared/provenance/README.md)
- [Shared events notes](../../shared/events/README.md)
- [Shared secret notes](../../shared/secret/README.md)

## Mailed verification and enumeration-safe sign-up (2026-09-23)

Sign-up used to answer `201 {identityId}` for a new email and `409` for a
taken one, and a development endpoint returned the raw verification token.
The first let anyone test which emails have accounts (hardening item S2).

- `SignUp` wraps `RegisterIdentity` and `IssueVerificationChallenge`. A new
  email gets its identity and a verification link through `IdentityMailer`,
  and a taken email gets a notice to its owner. Both hash the password before
  storage decides and return the same result; only failures that do not
  depend on existing accounts (invalid input, storage down) are reported. A
  challenge or message that could not be issued does not fail the sign-up,
  because `ResendVerification` recovers it.
- `ResendVerification` takes an email, not an identity ID. It mails a fresh
  link only to an identity still pending verification, and answers alike for
  every other address.
- The transport answers both with the same `202` body, no sooner than
  `N2F_SIGNUP_FLOOR_MS` after the request arrived. The extra work of a new
  sign-up (a challenge and two events) was measurable without the floor.
- Mail goes through the platform `Mailer`, which accepts a message and
  delivers it in the background, so the mail server's latency never shows in a
  response. The development transport keeps messages for `GET /dev/mail`;
  production requires SMTP.

Known limit: an unverified identity holds its email. If someone signs up with
another person's address, that person later receives the "account exists"
notice but cannot verify or sign in. Expiring unverified identities, or a
password reset that also verifies, would release the address.

