# Platform rate limiting

Platform rate limiting adapts the framework-free capability to Nest HTTP
without making product modules own storage or interceptor mechanics.

`PlatformRateLimitModule` provides a storage-selected store and global
`RateLimitInterceptor`. Controllers attach one or more policies with
`@RateLimit`; each policy supplies a name, rule and request-key resolver. The
interceptor consumes the policies in order and refuses at the first exhausted
one, naming it in the `429` problem response. Otherwise the limit headers
describe the policy with the fewest requests remaining.

Identity owns only its endpoint policies. Login carries three: client plus
email (repeated guesses at one account from one place), client alone (one
client spraying many accounts), and email alone (many clients guessing one
account). The per-account limit is the loosest because anyone can spend it to
lock an account out. Registration is keyed by client, and verification
operations by client plus their public identifier. Caller-supplied body fields
are SHA-256 digested before they join a key, so the key length stays within the
store bound whatever the client sends. No password, bearer token or
verification token becomes a rate-limit key.

The client is `request.ip`, which Express derives from the socket unless
`N2F_TRUST_PROXY` names the proxies in front of the process. Behind a load
balancer without that setting every client shares the balancer's address and
therefore one bucket. Trusting every proxy (`true`) is refused because it would
let a direct client choose its own address through `X-Forwarded-For`.

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
