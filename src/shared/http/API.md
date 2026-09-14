# HTTP native surface

The pure leaves implement [CONTRACT.md](CONTRACT.md) and [SHAPES.md](SHAPES.md).
They do not import SDK or framework types.

- problemOf(Result<unknown, unknown>): Problem | undefined. The result branch
  distinguishes success from a caught undefined/null failure.
- classifyCompletion(CompletionFacts): Result<Classification, Failure>.
- Outcome is imported/re-exported from telemetry.
- new Active(monotonicClock, outputs); finish(facts): Result<boolean, Failure>.
- nest.Server owns native response finish/close handling and AsyncLocalStorage.
  current() reads immutable scope/logger values for the executing request.
- Observer.start(method, scheme, headers) returns an owned trace projection,
  scoped run(callback), and finish(completion, route, scope, failure).

Feature routes (H15–H19), pure leaves in feature.ts:

- Route gains an optional method (default GET; HEAD served for GET) and an
  optional admission(request, signal) returning Result<Admission, unknown>.
- FeatureRequest: method, template, body (bounded bytes), headers (origin,
  content-type, x-csrf-token, sec-websocket-protocol as lists), cookies
  (name → list), source, query and the admitted value. RequestContext.request.
- parseCookies(header) → ReadonlyMap; malformed pairs are skipped, duplicates kept.
- serializeCookie(CookieValue): Result<string, Failure>; refuses control
  characters and `__Host-` cookies without Secure and Path=/ (http.invalid_cookie).
- Reply.create({status 200|201|202|204|303, body?, headers? from the allowlist,
  cookies?}): Result<Reply, Failure>; anything else is http.invalid_reply, which
  the adapter projects as a handler error before commitment.
- Refuse.create(error, {headers?, cookies?}): Result<Refuse, Failure>; a classified
  failure that a refusal writes with allowlisted headers (Retry-After) and cookies
  (a cleared session); the server unwraps it, so the inner error is classified.
- allowFor(methods) → the Allow header text for a template.
- Config.open(operation, incoming, attribution) now receives the admitted
  attribution; Config.source(remoteAddress, headers) derives the trusted source
  key (default: peer address only).

The concrete otel observer maps one completion to duration metrics, a SERVER span
and a safe OTLP log. Scope/error details enter log attributes, never metric labels.
Root owns registered route names, provider resources, admission limits and shutdown.
