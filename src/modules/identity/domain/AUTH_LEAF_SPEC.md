# Executable auth leaf decisions

These details make A01–A09 executable without silently choosing different behavior
in each language. The auth leaf APIs are implemented and pass these decisions in every build; they
are pure values, not hashing, token generation, persistence or endpoints.

- Login PasswordInput accepts 1..4096 UTF-8 bytes before NFC normalization; rejects
  malformed Unicode; normalization must remain within that bound. NewPassword also
  uses this input ceiling before applying the existing post-NFC 15..128 scalar /
  512-byte enrollment rule. Blocklist admission remains a separate application port.
- Email's explicit Reveal/reveal returns its canonical private text. Password values
  disclose only through a returned shared secret wrapper. Ordinary supported
  formatting/serialization must redact both. This is not memory protection.
- TokenDigest carries a validated closed purpose and exactly 32 bytes. All-zero bytes
  are valid digest data, not evidence that a zero Go value was constructed correctly.
  Returned bytes are owned copies. Digest parsing does not generate tokens, perform
  hashing or prove that the digest came from a CSPRNG token.
- CredentialSnapshot uses the existing secret wrapper for sensitive hash text.
  The leaf refuses empty or over-512-byte hash text as Internal
  identity.credential_corrupt. PHC format/parameter validation belongs to the concrete
  password adapter; a nonempty leaf hash is not proof of a supported Argon2 record.
  Other malformed credential fields use Invalid identity.credential_invalid.
  Human-principal eligibility requires an application lookup; a UUID alone cannot
  establish the referenced principal kind.
- AuthState invalid construction uses Invalid identity.auth_state_invalid. Stale
  expected epoch uses Conflict identity.version_conflict; increment at the common
  ceiling uses Conflict identity.version_exhausted. Increment returns a new state.
- Session restore requires issued <= lastSeen < absolute, lastSeen <= idle <= absolute,
  and both deadlines strictly after issued. Revoked time must be >= issued.
  Check evaluates only local session validity, not principal/credential eligibility.
  Refusal is Unauthenticated identity.session_rejected for revoked/expired/backward
  use. Bad snapshot, invalid time range/TTL or arithmetic overflow is Invalid
  identity.session_invalid. Touch validates current session before advancing time.
- Session revoke allows expired sessions, refuses time before lastSeen or outside
  the time range, is idempotent, and retains the first timestamp. It cannot grant use.
- Challenge restore validates IDs, purpose, digest, version and timestamps. Consumed
  time must be >= issued and < expiry; invalidation can happen after expiry.
  Invalid snapshots use Invalid identity.challenge_invalid. Consume with wrong
  purpose/version, terminal state, backward or expired time uses Unauthenticated
  identity.challenge_rejected. Invalid clock range uses Invalid identity.challenge_invalid.
  Invalidate preserves any consumed timestamp and its first invalidation timestamp.
- All snapshots preserve absent optional timestamps separately from present zero.
  Constructors, restore and transitions must not alias mutable caller storage.
  Credential replacement, cross-record auth epoch changes, challenge storage
  single-use and session eligibility remain application/persistence work.

The checked-in fixture file is copied into each independent repo; no test reads a
sibling repo. It defines portable scalar cases. Native tests cover malformed string
representations, zero/forged values, snapshot ownership and lifecycle sequences.
Negative cases now reach their guard assertions because the setup constructors are
implemented. The six selected mutations in `tools/mutations/auth.py` are this
stage's targeted evidence, not a coverage score.
