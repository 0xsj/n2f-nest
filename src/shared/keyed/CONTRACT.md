# Keyed digest contract

**Stage:** specified 2026-09-12. A small shared capability with two named
consumers: CSRF token signing in the identity HTTP transport and rate-limit
subject digests in the attempt limiter. It carries no policy about either.

K01 — A keyed digest is constructed from a root-supplied secret key wrapped in
the shared secret type; the key bytes are the UTF-8 bytes of that text and must
number at least 32. A shorter key, or a missing one, is
Invalid `keyed.configuration`. The key is never revealed by any supported
presentation of the value.

K02 — Sign(purpose, message) returns a 32-byte tag equal to HMAC-SHA256 over the
purpose's ASCII bytes, one zero byte and the message bytes. Purpose is a
non-empty ASCII label of at most 64 printable characters without whitespace; a
different purpose over the same message yields a different tag. Invalid purpose
is Invalid `keyed.purpose_invalid`.

K03 — Verify(purpose, message, tag) recomputes and compares in constant time,
returning true or false as a value. A tag that is not exactly 32 bytes is false
without a comparison. Verify never fails for a mismatch.

K04 — Sign and Verify never log and never format the key, message or tag. Tags
may be encoded by consumers however they need; this package hands out bytes.

K05 — The checked-in vectors (`testdata/vectors.json`: key, purpose, message
and tag as hex; every key is UTF-8 text) must pass in every build; they were generated once and
copied. A message that is not a byte sequence is Invalid `keyed.message_invalid`
where the language cannot exclude it statically.

Native shapes: Go `pkg/keyed`: `New(secret.String) (*Digest, error)`,
`(*Digest).Sign(purpose string, message []byte) ([32]byte, error)`,
`(*Digest).Verify(purpose string, message []byte, tag []byte) (bool, error)`.
Rust `shared::keyed`: `Digest::new(SecretString) -> Result<Digest, Failure>`,
`sign(&self, &str, &[u8]) -> Result<[u8; 32], Failure>`,
`verify(&self, &str, &[u8], &[u8]) -> Result<bool, Failure>`, using the `hmac`
crate. TypeScript `shared/keyed`: `Digest.create(key: SecretString)`,
`sign(purpose, message: Uint8Array): Result<Uint8Array, Failure>`,
`verify(purpose, message, tag): Result<boolean, Failure>` using `crypto.createHmac`
and `timingSafeEqual`.
