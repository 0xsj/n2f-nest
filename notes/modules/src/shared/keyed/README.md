# Keyed module notes

`Digest` provides purpose-bound HMAC-SHA256 over a secret key, a purpose label,
and a message. It is a capability, not a token, CSRF or rate-limit policy.

- Keys must contain at least 32 UTF-8 bytes.
- Purposes are short printable ASCII labels so call sites cannot accidentally
  create ambiguous or unbounded namespaces.
- Invalid input is a modeled failure; a valid but mismatched tag is `false`.
- Verification uses constant-time comparison and all presentations redact the
  key.

See [`src/shared/keyed/`](../../../../../src/shared/keyed/) and the stable HMAC
vector in its test.
