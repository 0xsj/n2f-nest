# Identity failure design

**Status:** Established for the Identity domain and application commands.

## Origin

Identity already used `Result` values, but most failures had an optional
`type: string` field. That represented useful runtime metadata without giving
TypeScript a closed set to exhaustively match.

## What changed

The Identity domain objects now expose closed failure unions:

- `IdentityFailure` for lifecycle and transition invariants;
- `CredentialFailure` for email, timestamp and credential-state invariants;
- `SessionFailure` for session state, revocation and expiry;
- `VerificationFailure` for challenge state and consumption.

The Identity application commands return `IdentityApplicationFailure` rather
than the broad shared `Failure` type. Their adapter-facing ports still accept
the open shared failure vocabulary, but each command normalizes those failures
at its boundary. Known Identity adapter outcomes retain their public kind and
code; unknown dependency outcomes become typed dependency failures with the
original value retained as a private cause.

`GetCurrentIdentity` has a narrower `CurrentIdentityFailure` union because it
can make a more specific distinction between authentication refusal, unavailable
storage and invalid internal session state.

## Before and after

Previously, Identity domain methods and commands returned `Result<T, Failure>`;
application code passed adapter failures through as generic values:

```ts
if (!usable.ok) {
  return usable;
}
```

Now the Session failure is matched by its closed union using `ts-pattern`:

```ts
return match(error)
  .with({ type: 'session.revoked' }, (revoked) => revoked)
  .with({ type: 'session.expired' }, (expired) => expired)
  .with({ kind: 'invalid' }, (invalid) => invalidSessionState(invalid))
  .exhaustive();
```

Adding another `SessionFailure` type now requires this mapping to be reviewed by
the compiler. The application does not leak the Session domain's entire error
vocabulary to the HTTP boundary. The pattern library is used only in the
application layer; domain objects remain framework- and library-free.

## Why the application boundary owns normalization

The Session domain knows that a session can be expired or revoked. The
`GetCurrentIdentity` query knows that both mean the caller cannot be treated as
the current authenticated Identity. It also knows that a broken session store
is an availability failure rather than an authentication refusal.

The same rule applies to commands: a password hasher, event writer or database
can expose an open infrastructure failure vocabulary, but the Identity command
must return an outcome meaningful to its callers. The original failure remains
available privately for diagnostics without becoming part of the domain's
public contract.

## Credential policy failures

Password length is an Identity-owned policy. Registration returns the typed
invalid failures `identity.password_too_short` and
`identity.password_too_long`, so a caller can correct its input. Authentication
uses the same upper bound as a work guard, but maps an oversized login input to
`identity.invalid_credentials`. This keeps the public login refusal uniform
while avoiding unnecessary password-verifier work on an input that cannot be a
valid Identity credential.

## Limits

- The adapter-facing ports remain open to shared `Failure` because external
  failure vocabularies are not closed. The application boundary is responsible
  for normalization.
- The application union is module-wide for now; individual commands can later
  narrow their error unions further if a consumer needs that precision.
- `ts-pattern` provides exhaustive checking at compile time, but casts or
  `any` can still bypass TypeScript's guarantees.

## Used in

- [`session.ts`](../../../../../src/modules/identity/domain/session.ts)
- [`identity.ts`](../../../../../src/modules/identity/domain/identity.ts)
- [`credential.ts`](../../../../../src/modules/identity/domain/credential.ts)
- [`verification-challenge.ts`](../../../../../src/modules/identity/domain/verification-challenge.ts)
- [`failures.ts`](../../../../../src/modules/identity/app/failures.ts)
- [`get-current-identity.ts`](../../../../../src/modules/identity/app/queries/get-current-identity.ts)

## Related

- [Error values and exception boundaries](../../../../architecture/error-values-and-exception-boundaries.md)
- [Identity domain design](DOMAIN-DESIGN.md)
