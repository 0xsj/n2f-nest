# Rate-limit capability notes

Rate limiting is a reusable capability, not an Identity domain concept. The
shared package defines only rules, decisions, a store port and a framework-free
coordinator; it does not know about HTTP, login, IP addresses or API routes.

## Current design

`RateLimiter` receives a key and rule, reads a `WallClock`, and delegates the
window mutation to `RateLimitStore`. The store returns a decision containing
allow/deny state, remaining capacity, reset time and retry delay. Expected
configuration failures are `Result` values.

The first implementation is a process-local fixed-window store under
`src/platform/ratelimit/`. It is deterministic, easy to test and appropriate
for one-process development. A Redis, PostgreSQL or gateway-backed store can
implement the same shared port when multiple instances need one global limit.

## Ownership rule

The reusable package owns mechanics. The caller owns policy and key meaning:

- Identity transport defines login, registration and verification limits.
- A future external API transport can define API-key, tenant or route limits.
- A worker or message consumer can use the same capability without importing
  Nest or Identity.

Keys are private implementation inputs. They must not contain raw secrets or
be returned in errors or response headers.

## Limits

Fixed windows can allow a burst at a window boundary and the current store is
process-local. Those are explicit tradeoffs, not hidden guarantees. A shared
adapter or sliding/token-bucket algorithm should be introduced only when the
deployment topology or product policy requires it.

## Used in

- `src/shared/ratelimit/index.ts`
- `src/platform/ratelimit/`
- `src/modules/identity/transport/http/identity.controller.ts`

## Related

- [Keyed digest capability](../keyed/README.md)
- [HTTP boundary](../http/README.md)
- [Environment configuration](../env/README.md)
