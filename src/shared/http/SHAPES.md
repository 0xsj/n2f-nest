# HTTP shapes for specification tests

**Stage:** implemented for the diagnostic JSON boundary. Native casing and ownership differ; the
same facts and scenarios apply in all three clones.

| Shape           | Members and constraints                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Problem         | H02 members; immutable-by-ownership projection, public field map copied                                                              |
| Start           | Normalized method and known http/https scheme; no raw request object                                                                 |
| CompletionFacts | Optional final status 200..599; optional selected failure kind; termination enum                                                     |
| Classification  | Outcome, span status unset/error, optional fixed error.type                                                                          |
| Completion      | Facts plus monotonic elapsed duration, optional registered route/operation and available safe scope/error projections                |
| Active          | Optional validated TraceRef, one terminal finish; no business return value                                                           |
| Observer        | Start an Active observation under the native request execution context                                                               |
| FeatureRequest  | Immutable: method, template, bounded body bytes, selected header lists, cookie name → list, source key, query, admitted              |
| Admission       | anonymous, authenticated (initiator actor, optional tenant, admitted value) or refused (error, optional retry-after)                 |
| Reply           | Status from 200/201/202/204/303, optional JSON body (none for 204), allowlisted headers, serialized Set-Cookie list                  |
| Refuse          | A classified failure plus allowlisted headers and serialized Set-Cookie list; the server applies them and classifies the inner error |
| CookieValue     | Name, value, path, max-age or expiry, Secure, HttpOnly, SameSite; `__Host-` requires Secure and Path=/                               |

Termination is response_completed, peer_closed, deadline, handler_error,
write_error or abandoned. response_completed requires a final status. Other
terminations may lack status. Invalid status/enum/combination refuses with
invalid / http.invalid_completion and no observation effects. A projection of an
unknown failure uses internal as its selected kind; classification presence and
raw source retention still belong to the error/logger modules.

Classify facts in this precedence order:

1. peer_closed → canceled; deadline → timed_out; handler_error/write_error/abandoned
   → failed. An observed application result is separate from transport termination.
2. With response_completed and a selected failure, use H01's outcome mapping.
3. Otherwise completed 2xx/3xx → success, 4xx → refused, 5xx → failed.

Span status is Error for any non-completed termination, 5xx status, or
failed/canceled/timed_out outcome; otherwise unset. Pick error.type in order:
explicit termination reason (peer_closed becomes canceled, deadline becomes timeout),
selected timeout/canceled, 5xx status string, then handler_error for a remaining
failed outcome. No error.type when span status is unset. A 5xx remains an error even if the selected application outcome is refused. A recovered exception that emits
500 may complete its response normally but still has a failed outcome.

Route is optional until the router supplies a registered template. Raw path is
not an alternate member. Elapsed is a native duration converted to seconds for the
histogram and milliseconds for logs at projection, not wall end minus wall start.
Status refers to the server writer's known final status, never proof of receipt.

A fake Observer records explicit starts/finishes without SDK initialization.
The lifecycle layer—not a test double that silently deduplicates calls—must own
once-only completion. Tests inspect callbacks to each output independently.
A no-op observer emits no TraceRef, but the HTTP lifecycle still serves its handler.

This shape deliberately does not prescribe a universal SDK Span interface or
an application request context bag. Match the final native public signatures to
these tests before implementing their bodies; record any contract change first.
