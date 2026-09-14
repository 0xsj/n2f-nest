# Keyed digest: the key is text

**Origin:** implementing K01–K05 spec-first on 2026-09-12.

The contract wraps the key in the shared secret type, which holds a string.
Node turns that string into bytes as UTF-8, so a key is only the byte sequence
the text encodes. The first shared vectors were generated from raw bytes and one
of them (forty 0xab bytes) could not round-trip through any string. Rather than
add a second, byte-keyed secret type, the contract now states that key bytes are
the UTF-8 bytes of the secret text and the vectors were regenerated with text
keys; every vector is reproduced here. The finding is worth keeping: a fixture
generated in a language whose strings hold arbitrary bytes can encode inputs a
text-keyed language cannot construct.

Purpose validation is a regex over printable ASCII without whitespace, at most
64 characters, checked before any HMAC call. Verify computes the expected tag
first, so an invalid purpose fails the same way for both operations; a tag of
the wrong length is false without a comparison, because `timingSafeEqual`
throws on length mismatch.

A malformed message (not a `Uint8Array`) is Invalid `keyed.message_invalid`,
a type the contract does not name; TypeScript alone does not stop a caller from
passing a string at runtime.

**Limits:** five vectors, four representable. No consumer exists yet.

**Used in:** index.ts and keyed.spec.ts. See [the contract](../../../../../src/shared/keyed/CONTRACT.md).
