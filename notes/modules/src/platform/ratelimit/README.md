# Platform rate limiting

Platform rate limiting adapts the framework-free capability to Nest HTTP
without making product modules own storage or interceptor mechanics.

`PlatformRateLimitModule` provides a storage-selected store and global
`RateLimitInterceptor`. Controllers attach a policy with `@RateLimit`; the
policy supplies a name, rule and request-key resolver. The interceptor writes
standard limit headers and maps a denied decision to a `429` problem response.

Identity owns only its endpoint policy: login is keyed by client and normalized
email, registration by client, and verification operations by client plus their
public identifier. No password, bearer token or verification token becomes a
rate-limit key.

Memory mode uses a process-local fixed-window store for fast development and
tests. PostgreSQL mode uses an atomic `n2f_rate_limits` upsert, so multiple
backend processes share the same bucket without changing endpoint policies or
application domains. The store port is asynchronous so a Redis or gateway
adapter can be substituted later.

## Used in

- `src/platform/ratelimit/ratelimit.module.ts`
- `src/platform/ratelimit/rate-limit.interceptor.ts`
- `src/platform/ratelimit/postgres/store.ts`
- `src/modules/identity/transport/http/identity.controller.ts`
- `test/identity.integration.spec.ts`
- `test/persistent-e2e.integration.spec.ts`
- `test/rate-limit-cluster.integration.spec.ts`

The cluster check starts two compiled backend processes with local event
delivery but shared PostgreSQL storage. Five login attempts sent to each
process still cause the eleventh request to receive `429`, proving the bucket
is not process-local in PostgreSQL mode.

The persistent HTTP E2E harness clears only `identity.register` buckets before
its run. Registration is intentionally limited by client IP, so this keeps a
repeated local test deterministic without weakening the production policy or
clearing login-abuse buckets.

## Related

- [Shared rate-limit capability](../../shared/ratelimit/README.md)
- [Identity module](../../modules/identity/README.md)
