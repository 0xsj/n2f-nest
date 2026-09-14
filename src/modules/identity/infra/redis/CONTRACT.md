# Identity Redis limiter contract

**Stage:** specified for stage 7 on 2026-09-13. This adapter implements the
identity `AttemptLimiter` port using Redis as a shared, atomic fixed-window
store. The process-local adapter remains a test/development choice; root
selects the implementation explicitly.

## Limiter

R01 — `Admit(operation, subject, source)` evaluates one atomic Redis script for
all configured subject and source buckets. Every call increments each bucket,
including a call that is refused by another bucket. A permit requires every
bucket to remain within its limit. A refusal returns the greatest remaining
window as retry-after milliseconds.

R02 — Bucket fields are HMAC-SHA256 digests using the keyed capability's
`rate_limit` purpose over `operation || 0x00 || value`. Redis stores only the
hex digest in its bounded bucket state; raw email, token digest input and source
keys never become Redis keys, fields, logs or errors.

R03 — The adapter keeps bucket expiry and counts in a namespaced Redis index.
Expired buckets are evicted during admission. `max_keys` bounds distinct live
buckets; a full store returns Unavailable `identity.auth_dependency_failed`.
The adapter never fails open. Redis errors, malformed replies, timeouts and an
invalid clock reading have the same operational refusal.

R04 — Construction validates a `redis://` endpoint, a positive operation
timeout and the same operation limits as the local adapter. The Redis command
is bounded by the configured timeout. TLS, cluster credentials and pooling are
separate adapter extensions; an unsupported endpoint refuses startup rather
than silently downgrading protection.

R05 — `AUTH_LIMITER=local` selects the process-local adapter. `AUTH_LIMITER=redis`
requires the secret `AUTH_LIMITER_REDIS_URL` and selects this adapter. The root
manifest says `process_local` or `redis`; it never prints the URL or password.

## Trusted source policy

P01 — `HTTP_TRUSTED_PROXIES` is a comma-separated list of IP addresses or CIDR
prefixes. With an empty list, the source key is the canonical peer address and
forwarding headers are ignored. A forwarding header is considered only when
the immediate peer is in the configured list.

P02 — A trusted request parses every comma-separated `X-Forwarded-For` value as
an IP. If any value is malformed, the policy falls back to the peer address.
Otherwise it walks the chain from the peer side and chooses the first address
not covered by the trusted-proxy list. If all addresses are trusted, it uses
the leftmost address. The output is a canonical IP string, never the raw header.

## Verification

R06 — Specs cover atomic subject/source counting, retry-after, expiry, bounded
state and unavailable Redis, digest-only state, URL/timeout validation and
script reply validation. A real Redis process proves two independent clients
share a refusal and that restarting the app does not reset the window.

P03 — Source-policy specs cover no proxy trust by default, exact IP/CIDR trust,
untrusted peers ignoring forwarding headers, malformed headers falling back,
multi-hop right-to-left selection and canonical output.

## Native shapes

Go: `redis.NewLimiter(config, keyed, clock)` and `root.TrustedSource`.
Rust: `RedisLimiter::new(...)` and `root::trusted_source(...)`.
TypeScript: `RedisLimiter.create(...)` and `trustedSource(...)`.
