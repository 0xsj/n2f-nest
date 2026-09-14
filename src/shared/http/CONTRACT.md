# HTTP boundary contract

**Stage:** implemented for the bounded diagnostic JSON consumer. Native process,
SDK delivery and selected regression evidence are recorded in the root notes.

This module owns reusable HTTP ingress, safe failure presentation and request
completion. Feature routes and authorization belong to their feature owners;
root composes them. HTTP declares a narrow observation capability and consumes
telemetry values, errors, provenance, clocks and logger projections. Its pure
leaves know no framework or OpenTelemetry SDK.

## H01 — A failure has one safe wire projection

Map the shared public error projection into application/problem+json. A missing
error produces no problem. Never reinterpret an arbitrary foreign exception's
status/message properties as a trusted classified failure.

| Shared kind                      | HTTP status                            | Default request outcome |
| -------------------------------- | -------------------------------------- | ----------------------- |
| invalid                          | 400                                    | refused                 |
| not_found                        | 404                                    | refused                 |
| conflict                         | 409                                    | refused                 |
| unauthenticated                  | 401                                    | refused                 |
| forbidden                        | 403                                    | refused                 |
| rate_limited                     | 429                                    | refused                 |
| unavailable                      | 503                                    | failed                  |
| timeout                          | 503                                    | timed_out               |
| canceled                         | 503, only while a response is writable | canceled                |
| internal or unclassified failure | 500                                    | failed                  |

This is the service boundary's default mapping. A generic timeout does not say
that a gateway timed out (504) or that the client failed to send its request (408).
A known peer disconnect yields no new response, including no invented wire 499.
Framework request parsing can own 408/413/415; an auth adapter owns its required
WWW-Authenticate challenge for 401. Never invent a scheme or Retry-After delay
from error kind alone. These protocol facts need explicit adapter inputs.

Transport-owned method/body rejections can select an explicit 405/408/413/415
instead of the default invalid → 400 mapping. They retain kind invalid, a fixed
public http.* code/message, and a title/status matching the actual response.
This is an allowlisted protocol override, never a foreign exception's status.
An unmatched route uses not_found with 404. Test overrides and required headers
at the adapter boundary before claiming support.

## H02 — Problem members preserve meaning and ownership

The initial profile uses these members. Optional absence means omission, not null.

| Member          | Source                                                             |
| --------------- | ------------------------------------------------------------------ |
| type            | `urn:n2f:problem:<kind>`, fixed kind vocabulary from H01           |
| title           | Fixed English HTTP reason phrase for the selected status           |
| status          | Exactly the status selected for the response                       |
| detail          | Existing safe public message; Internal/unknown is "internal error" |
| kind            | Shared public kind; unknown failures become internal               |
| code?           | Nonempty public error Type, never DiagnosticType                   |
| fields?         | Nonempty copied map of public field explanations                   |
| request_id?     | This request's locally generated scope ID, when available          |
| correlation_id? | Accepted/generated provenance correlation ID, when available       |

The problem type URI identifies the category; a dotted application error Type is
not substituted for that URI. Do not flatten fields into problem members.
Do not expose causes, details, actor/tenant records, stack traces or raw request
URLs. Omit instance until an occurrence-URI policy has a consumer. Serialization
failure before commitment falls back to a fixed safe 500 response; it never dumps
the failed value. Projection is pure and does not generate IDs or log.

For example, a classified conflict with Type account.email_taken and an explicitly
public message "email is already registered" produces:

```json
{
  "type": "urn:n2f:problem:conflict",
  "title": "Conflict",
  "status": 409,
  "detail": "email is already registered",
  "kind": "conflict",
  "code": "account.email_taken",
  "fields": { "email": "already registered" }
}
```

This fixture omits request context; the live adapter supplies the optional IDs.
JSON member ordering is not part of the contract. The profile follows
[RFC 9457](https://www.rfc-editor.org/rfc/rfc9457.html); the kind/code/fields and
provenance members are n2f extensions, not an assertion of Flover compatibility.

## H03 — Admit hints without adopting authority

Read X-Correlation-ID through provenance's incoming inspector. Exactly one valid
value can continue external correlation; missing creates fresh local correlation;
empty, repeated or malformed restarts it. Never echo rejected text. Do not join
multiple header values into an apparently valid hint.

Ignore incoming X-Request-ID and generate a fresh execution Scope. The response's
X-Request-ID is an alias of scope_id, not another UUID or a trace ID.
X-Correlation-ID matches that scope's accepted/generated correlation.
Initial public requests use explicit anonymous initiator and a root-supplied named
service executor. No header sets actor, tenant, delegation, attempt, replay, origin
or depth. An auth integration later supplies verified attribution through a
separate boundary; trace/baggage headers are never an auth mechanism.

The first codec adopts only correlation. Extra causal headers, persisted work
decoding and outbound propagation remain later provenance adapters. Generation
failure short-circuits the handler with a safe 500 while writable, omits IDs it
could not obtain, and still completes the HTTP observation. No fallback fake Scope.

## H04 — Propagate tracing separately

Use the selected SDK's W3C propagator behind an adapter. A valid incoming parent
continues the trace with a fresh server span; absence/malformed/ambiguous repeated
traceparent starts local context and never causes an HTTP refusal. Discard invalid
tracestate without discarding an otherwise valid parent. Neither field is logged
raw. Do not hand-roll a partial protocol parser in the TraceRef leaf.

Provenance admission and trace admission are independent: bad correlation must not
discard a valid trace, and bad tracing must not discard accepted correlation.
Sampling remains root policy. Default ingress does not adopt baggage. These rules
use [W3C Trace Context](https://www.w3.org/TR/trace-context/); telemetry's no-op mode
creates no trace. No response traceparent or trace ID is promised by this profile.

## H05 — Start one owner, then route

Start the observation and monotonic interval at the application ingress boundary
before invoking routing/handlers; decoding failures visible at this boundary are
included. The server's lower-level malformed-request handling remains its owner.
The server span begins with normalized method; once routing identifies a template,
attach that registered template and its fixed operation name. Never derive a route
template by trimming a user-supplied path or reading an arbitrary header.

Normalize known methods GET, HEAD, POST, PUT, DELETE, CONNECT, OPTIONS, TRACE, PATCH;
all others use _OTHER for attributes and HTTP for span naming. Missing route means
omit http.route and use a fixed http.unmatched provenance operation. Matched routes
supply fixed operation names before opening their Scope; failed pre-routing
admission uses fixed http.ingress. No mutable operation change on a retained Scope.

## H06 — Finish once using the facts actually observed

The HTTP-owned active handle receives route/status/outcome facts and has one
terminal transition. Finalization attempts at most one completion log, one duration
sample and one span end. Competing callbacks, recovery paths and normal completion
must not double count. Record actual final status committed to the server writer,
if known; planned status and informational 1xx do not count as a final status.

For the first bounded JSON endpoints, completion means the response body has been
handed to the server runtime, or the exchange was observed to terminate. It is not
proof the client consumed it. A known incomplete write, peer close, server deadline
or abandoned handler cannot be counted as ordinary completed success. Preserve an
already observed application outcome separately when transport termination differs;
cancellation supplies no rollback/commit guarantee.

A peer close gives canceled; the server-owned deadline gives timed_out; handler,
encoding or write failure gives failed. Otherwise 4xx is refused, 5xx failed, and
a completed 2xx/3xx is success. A classified timeout/cancellation keeps its specific
outcome even when represented by 503. First accepted terminal facts win; a later
application error may be logged separately but cannot rewrite an ended exchange.

## H07 — Response commitment is irreversible here

Recover a handler panic/throw into the safe unknown-failure 500 only before the
final response is committed and while the connection is writable. After commitment,
do not append a problem document, change the recorded status, call a handler again
or claim rollback. End/abort using the framework's supported mechanism and record
the incomplete/failed exchange.

No catch-all wrapper can recover process aborts or guarantee interception of every
transport/runtime panic. Write failures and framework completion semantics need
real adapter tests. Streaming, hijacking and WebSocket upgrades require their own
handoff contracts before being supported by this boundary.

## H08 — HTTP metrics and span status stay bounded

Emit the stable http.server.request.duration histogram in seconds for every observed
completion, including sampled-out traces. Use the same boundary interval as the
server span. Attributes: normalized http.request.method, known url.scheme, optional
http.route and actual http.response.status_code, plus a fixed bounded error.type
only for failures. Add n2f.outcome from T02. Use configured scheme/trusted transport
facts; untrusted forwarded headers must not set it.

For metrics and span failure classification, error.type is a fixed reason:
timeout, canceled, handler_error, write_error, abandoned, or the 5xx status string.
A handled 4xx has none. Never use arbitrary error Type/message as a metric label.
Do not label with raw path, query, user/tenant/trace/request/correlation IDs or
caller-controlled host. No automatic payload/header collection.

For SERVER spans, ordinary 2xx/3xx and handled 4xx leave status unset; 5xx or an
observed incomplete exchange set Error. Do not set Ok automatically or use the
logger's severity as span status. Omit an actual status that was never committed.
This maps [OTel HTTP spans](https://opentelemetry.io/docs/specs/semconv/http/http-spans/)
and [duration metrics](https://opentelemetry.io/docs/specs/semconv/http/http-metrics/)
into this boundary's policy. Success/refusal/failure remain visible through
n2f.outcome even where span status is unset.

## H09 — One safe completion event

Log message http.request.completed with method, registered route when known,
actual status when known, outcome, termination reason and elapsed_ms as ordinary
fields. Bind explicit service, available Scope and TraceRef, and safe error
projection. Use info for normal success/refusal, warn for cancellation/deadline and
error for failed exchanges. A route owner may add meaningful events; that does not
authorize duplicate automatic completion logs. Logger filtering and delivery can
drop this attempt; log export is not guaranteed by the lifecycle guard.

## H10 — Request context survives overlap and cleans up

Scope and trace bindings must follow each request through awaited/nested execution
and restore outer bindings on every exit. Plain domain/app methods receive their
own required inputs, never a giant HTTP request bag or a framework request object.
No-op telemetry preserves response/error/provenance behavior. SDK context is confined
to the adapter; lifecycle state is never a global mutable current request.

## H11 — This first server is a bounded diagnostic consumer

Root will assemble GET /_examples/http/success (200 JSON), /conflict (409),
/unavailable (503) and /unknown (500) under the same /_examples/http prefix.
Example error codes/messages are fixtures, not a new business module. Unmatched
routes return a safe 404; method mismatch retains 405 and the server's Allow header.
HEAD sends no body. Shared projection must not discard required protocol headers.

Examples are an explicit development command/profile, not automatically added to
production routes. Request/header/body and handler deadlines need explicit root
limits before the real server is implemented. No speculative database/cache probe
is added to readiness; liveness/readiness policy remains a separate process concern.

## H12 — Export outage cannot change the response

With the collector unreachable or a saturated telemetry queue, the same fixture
request still has the same status/body/provenance rules. Bounded loss and recovery
are observable separately. Request completion never waits for provider flush.
Root drains HTTP before shutting down telemetry, spending a single remaining
shutdown budget. This is a process integration checkpoint, not a unit-test claim.

## H13 — Comparable tests before implementation

The next tests use the public shapes in API.md. Cover all ten classified kinds,
unknown and absent errors (including JS throw undefined/null), outer classification precedence, immutable fields,
Internal redaction, all admission combinations, method/route normalization and
sampling-independent outcomes. Fake clocks must include wall rollback with
positive monotonic elapsed time. Exercise complete/close/deadline/error races and
post-commit failure without duplicate completion.

Selected mutations should remove redaction, equate IDs, admit repeated headers,
use a raw path label, suppress metrics when unsampled, reclassify 409 as span Error,
finish twice, and write a second response after commitment. A compiling mutant
and observed failure are required before counting it caught.

## H14 — Evidence progresses through boundaries

Pure projection tests cannot validate framework lifecycle hooks. After leaves,
test the real Go/Nest/Rust adapters with overlapping requests, routing failures,
disconnects and writes. Then run the actual process against local OTLP stores and
retrieve the linked signals, including an outage/recovery/shutdown exercise.
Finally run a Flover client against the chosen wire profile; similar JSON alone
does not demonstrate compatibility. No such evidence exists for this slice yet.

### H11 diagnostic verification fixtures
The named diagnostic executable may explicitly enable HTTP_TEST_ROUTES=true
(default false). This registers three fixed test routes: /_examples/http/panic
(caught unknown failure), /_examples/http/delay (cooperatively waits twice the
configured handler deadline), and /_examples/http/context (yields and returns the
request scope ID before/after). These fixtures perform no external write and are
not product endpoints. They establish cancellation, redaction and context evidence
against the same native boundary used by the four normal examples.

## Feature routes: methods, bodies, cookies and admission

**Stage:** implemented and mutation-checked in every build on 2026-09-12 for the
identity authentication routes; H01–H14 remain in force and the diagnostic routes
keep their current behavior. This
section extends the boundary beyond GET/HEAD without moving feature policy into
it: which cookie, which origin, which CSRF rule and which principal belong to the
feature transport that registers the route.

### H15 — A route names its method and receives a bounded request value

A route is registered with exactly one method from the H05 known set plus its
path template; the same template may be registered under several methods. An
unmatched template is 404; a matched template with an unregistered method is 405
with an Allow header listing exactly the registered methods for that template.
HEAD is served for every GET route without a body.

The handler receives an immutable request value, never the framework request:
the normalized method and registered template; the raw body bytes when the
request carried a body, already bounded by the root's limit and already refused
with the existing 413/415/408 overrides when oversized, not `application/json`,
or not received within the timeout (a non-JSON body on a route that expects none
is still 415; an absent body is an empty value, not an error); the selected
request headers Origin, Content-Type, X-CSRF-Token and the agreed WebSocket
subprotocol header, each as the list of values received; the Cookie header
parsed into name → list of values, so a duplicated name is visible to the route
owner rather than silently reduced; and a trusted source key derived at root from
the peer address and the configured trusted-proxy policy (the boundary never
trusts a forwarding header by itself). Query strings are exposed as raw text;
this profile registers no route that reads one.

Body decoding into a typed shape belongs to the route owner, using a strict
decoder (unknown members refused, no duplicate keys, depth and size bounded by
the already-enforced limit). The boundary does not parse JSON on the owner's
behalf beyond the media-type refusal.

### H16 — A route returns a response value

The handler returns either a classified failure, projected exactly as H01–H02
require, or a response value: a status from 200, 201, 202, 204 or 303; an
optional JSON body (none for 204); and headers from a fixed allowlist:
Cache-Control, Set-Cookie (a list), Allow, WWW-Authenticate, Retry-After and
Location. Any other header name is a handler error (500) before commitment, not a
silent drop. The boundary adds X-Request-ID and X-Correlation-ID as before. A handler cannot
write the body itself, stream, hijack or upgrade; those remain separate handoff
contracts. A handler or admission may also refuse with headers: a classified
failure carrying allowlisted headers and a Set-Cookie list, which the boundary
unwraps so the problem projection keeps the failure's classification while the
headers and cookies are written (a 401 that clears a cookie, a 429 with
Retry-After, a problem response marked no-store). A zero or negative Max-Age
serializes as `Max-Age=0` and is the clearing form.

Set-Cookie values are constructed by the route owner from a cookie value type
that the boundary serializes: name, value (already encoded by the owner), Path,
Max-Age or an explicit expiry, Secure, HttpOnly and SameSite. The boundary
refuses a cookie whose name has the `__Host-` prefix without Secure, Path=/ and
no Domain, and refuses control characters anywhere. It never logs a cookie value.

### H17 — Admission runs after routing and before the scope opens

A route may register an admission function. After the template and method are
matched and before Open, the boundary calls it with the request value and a
pre-scope context that carries the trace parent but no provenance scope. It
returns either a refusal, an anonymous admission, or an authenticated admission
carrying the initiator actor (and optional tenant) plus an opaque admitted value
for the handler. Open then receives that attribution, so the request's provenance
scope is entered with the established initiator and the root-supplied service
executor (A19); no header can set it. The admitted value reaches the handler
through the request value, never through a global.

A refusal from admission is projected like any failure (401 for unauthenticated,
403 for forbidden, 429 with the owner-supplied Retry-After for rate limits) and
still receives the ordinary completion observation with the route template and
the fixed `http.admission` provenance operation. Admission never runs for an
unmatched route or a 405, and it runs at most once per request.

### H18 — Completion facts do not change

H06–H09 apply unchanged to feature routes: one completion log, one duration
sample, one span end, first terminal facts win, and commitment is irreversible.
A 4xx refusal from admission or a handler is `refused`; a handler failure is
`failed`; the response status recorded is the one committed. Feature routes add
no automatic request or response payload logging, and the boundary never places
body bytes, cookies, tokens or header values in logs, spans or metrics.

### H19 — Evidence for the extension

Pure tests cover method matching and the Allow set, the body refusals, cookie
parsing with duplicates and malformed pairs, the response-header allowlist, the
`__Host-` cookie refusals and the admission ordering (admission before Open,
never for 404/405, exactly once). Real adapter tests cover a POST with a bounded
JSON body, a 204 with Set-Cookie, an admission refusal with observation, and an
overlapping authenticated and anonymous request pair whose scopes carry different
initiators. Selected mutations: Allow set omitted, duplicate cookie collapsed,
admission after Open, header allowlist bypassed, admission run twice, and a
cookie value reaching the completion log.
