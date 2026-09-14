# TypeScript: canonical base64url is a round trip, not a regex

**Origin:** implementing the token codec contract (T01–T08) spec-first on
2026-09-12, then confirming three named mutations by hand.

A regex proves the alphabet and the length, but not canonical form. A 43-character
secret carries 258 bits; the last character's two low bits must be zero, and
`Buffer.from(secret, 'base64url')` decodes a non-zero tail without complaint. The
`noncanonical_tail` fixture is caught only by re-encoding the 32 bytes and
comparing to the input, which is the check the `noncanonical_accept` mutation
removes. `Buffer` also accepts the standard alphabet under `'base64url'`, so the
`+` and `/` rejects depend on the regex, not on the decoder.

The digest binds purpose by feeding the purpose text, one zero byte and the raw
token into one SHA-256 stream. Removing the two prefix updates fails every
fixture vector, so the fixture is the evidence that all three builds agree on
the exact byte layout rather than merely on "hash the token".

Entropy failure must not fall back. The codec allocates the 32-byte buffer, calls
the injected filler and returns `identity.entropy_unavailable` from the catch;
the mutation that zero-fills and continues is caught by the failing-entropy test
because the issued value would otherwise look valid.

`Issued` is a frozen plain object holding a `SecretString` and a `TokenDigest`.
Both values own their redaction hooks, so `JSON.stringify` and `util.inspect` on
the container print `[REDACTED]` for each field without a wrapper class.

**Limits:** three of the seven stage mutations touch this codec. Storage lookup,
cookie transport and comparison against stored digests are not implemented here.

**Used in:** index.ts and token-codec.spec.ts. See the
[contract](../../../../../../src/modules/identity/token-codec/CONTRACT.md).
