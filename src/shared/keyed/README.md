# Keyed

An HMAC-SHA256 digest over a purpose label, one zero byte and a message, keyed
by a root-supplied secret that no presentation discloses. Verify answers false
as a value and compares in constant time. Consumers: CSRF token signing and
rate-limit subject digests; the module carries neither policy.

- [Contract](CONTRACT.md): K01–K05 and native shapes.
- [Vectors](testdata/vectors.json): copied verbatim into each build.
- [Module documentation](index.ts).
- [Implementation notes](../../../notes/modules/src/shared/keyed/README.md).
