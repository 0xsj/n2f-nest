# Token codec adapter contract

**Stage:** implemented and mutation-checked in every build on 2026-09-12. This identity-owned adapter implements the token generation
and digest half of A05. It depends on the identity domain's TokenPurpose and
TokenDigest values, the shared secret wrapper, shared errors and an injected entropy
capability. Storage, cookies, headers and comparison against stored digests belong
to later stages.

## Behavior

T01 — Issue(purpose) draws exactly 32 bytes from the injected cryptographic entropy
and returns the secret as a redacting string of 43 canonical unpadded base64url
characters plus its TokenDigest. An invalid purpose is Invalid
`identity.token_invalid`. Entropy failure is Unavailable
`identity.entropy_unavailable`; there is no UUID, timestamp, PRNG or other fallback.

T02 — Digest(purpose, secret) accepts only a secret of exactly 43 characters from
the base64url alphabet `A–Z a–z 0–9 - _`, unpadded, that decodes to 32 bytes and
re-encodes to the identical string (non-zero trailing bits, padding, whitespace,
standard-alphabet `+` `/` and non-ASCII are all refused). Otherwise Invalid
`identity.token_invalid`. The purpose is validated the same way as in T01.

T03 — The digest is SHA-256 over the purpose's UTF-8 bytes, one zero byte, and the
32 raw token bytes. The same secret under different purposes yields different
digests; the resulting TokenDigest carries its purpose.

T04 — For an issued token, Digest(purpose, secret) equals the issued digest.

T05 — Issued secrets are redacted in every supported presentation of the returned
value; digests are the already-redacting domain value. The codec never logs.

T06 — A missing entropy capability is refused at construction with Invalid `identity.token_codec_configuration`. Rust cannot construct an invalid purpose or a missing entropy value, so its T01 and T06 refusals are unreachable by construction; `Codec::new` keeps the Result for shape parity.

T07 — The checked-in vectors (`testdata/vectors.json`: purpose/secret/digest
triples and canonical-form rejects) must pass in every build.

T08 — Digest makes no constant-time claim; no secret comparison happens in this
adapter. Comparison happens by digest lookup at storage.

## Native shapes

Go (`internal/identity/tokencodec`): `New(entropy io.Reader) (*Codec, error)`;
`(*Codec).Issue(domain.TokenPurpose) (Issued, error)` with
`Issued{Secret secret.String; Digest domain.TokenDigest}`;
`(*Codec).Digest(domain.TokenPurpose, secret.String) (domain.TokenDigest, error)`.

Rust (`domains::identity::token_codec`): `Codec::new(entropy: E) -> Result<Codec<E>, Failure>`
with `E: Entropy`; `fn issue(&self, TokenPurpose) -> Result<Issued, Failure>`
(entropy behind an internal mutex so the codec is shared by reference);
`fn digest(&self, TokenPurpose, &SecretString) -> Result<TokenDigest, Failure>`.
`Issued` has no Debug derive.

TypeScript (`modules/identity/token-codec`): `TokenCodec.create(entropy: Entropy): Result<TokenCodec, Failure>`;
`issue(purpose: TokenPurpose): Result<Issued, Failure>`;
`digest(purpose: TokenPurpose, secret: SecretString): Result<TokenDigest, Failure>`.
