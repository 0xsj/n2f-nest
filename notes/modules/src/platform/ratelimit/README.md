# Platform rate limiting

Platform rate limiting adapts the framework-free capability to Nest HTTP
without making product modules own storage or interceptor mechanics.

`PlatformRateLimitModule` provides a process-local store and global
`RateLimitInterceptor`. Controllers attach a policy with `@RateLimit`; the
policy supplies a name, rule and request-key resolver. The interceptor writes
standard limit headers and maps a denied decision to a `429` problem response.

Identity owns only its endpoint policy: login is keyed by client and normalized
email, registration by client, and verification operations by client plus their
public identifier. No password, bearer token or verification token becomes a
rate-limit key.

The current adapter is intentionally local. Multi-instance deployment requires
replacing the `RateLimitStore` provider with a shared implementation; the
controller decorators and application domains should not change.

## Used in

- `src/platform/ratelimit/ratelimit.module.ts`
- `src/platform/ratelimit/rate-limit.interceptor.ts`
- `src/modules/identity/transport/http/identity.controller.ts`
- `test/identity.integration.spec.ts`

## Related

- [Shared rate-limit capability](../../shared/ratelimit/README.md)
- [Identity module](../../modules/identity/README.md)
