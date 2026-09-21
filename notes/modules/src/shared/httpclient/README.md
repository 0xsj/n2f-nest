# HTTP client module notes

The outbound client performs one bounded HTTP attempt and returns transport
results without silently following redirects or rewriting refusal statuses.

## Origin

This slice preserves the useful client boundary from the previous build while
keeping it small enough to replace with another adapter later. It is intended
for integration modules, not domain logic.

## What and why

- Origins are constrained to an HTTP(S) origin without path, credentials,
  query or fragment. Requests are relative paths and cannot escape the origin.
- Request and response bodies are bounded, active attempts are capped, and
  every attempt has a timeout or caller cancellation path.
- A 302 or 409 is returned as a response. Redirect policy and business meaning
  belong to the integration owner.
- `traceparent` is injected only from a validated shared `TraceRef`.
- A bearer token is a `SecretString`, and the client never includes it in a
  returned failure.

## Gotchas

- The client uses Node's native HTTP implementation and therefore belongs to
  infrastructure, not `src/shared` domain contracts in the architectural
  sense. It remains here because several integrations will need the same
  policy.
- Loopback integration tests require `SIGNALS_TEST_NETWORK=1`; the default
  test run does not assume permission to open local sockets.
- The client does not retry. Retry ownership requires operation semantics,
  idempotency and backoff, so it belongs in the consuming integration.

## Used in

- `src/shared/httpclient/index.ts`
- `src/shared/httpclient/client.spec.ts`

## Related

- [`http`](../http/README.md)
- [`secret`](../secret/README.md)
- [`telemetry`](../telemetry/README.md)
