# Identity HTTP transport: refusals are values, and CSRF rotation shapes the client

**Origin:** implementing R01–R15 spec-first on the real Nest adapter with the
stage 4 operations wired to an in-memory store, on 2026-09-12.

The shared boundary could not express two things the contract requires of a
refusal: a `Retry-After` header on 429 (R08) and a cleared session cookie on 401
(R07). Success replies carry headers and cookies, but a handler failure only
carried its classification. The fix is a `Refuse` value beside `Reply`: a
classified error plus allowlisted headers and cookies, validated at construction
the same way, unwrapped by the server so the inner error is what gets classified
and logged. Admission refusals and handler refusals both use it.

`JSON.parse` cannot report a duplicate key, so R02's "duplicate keys refused"
needed a small parser of its own: one top-level object, depth bounded, control
characters and lone surrogates refused, trailing content refused. It decodes
into a null-prototype object so a key named `__proto__` is just a key.

The CSRF binding follows the request, not the route. A session-bound token sent
together with the session cookie is valid on an anonymous route such as
`/register`, because the binding is derived from the cookie that is actually
present; the same token without the cookie is refused. `GET /csrf` with an
invalid session cookie issues an anonymous context rather than a 401, so a
client whose session expired can recover without a second round trip.

Every logout rotates the CSRF context (R11), which makes the executable spec's
client stateful: it must re-fetch a token after each logout, and a cookie jar
that honors `Max-Age=0` drops the real session after a deliberate duplicate-cookie
probe. Both cost a debugging round; they are the contract working as written.

**Limits:** the in-memory store has no locks and one process; the transport's
behavior against the real store is covered only by `tools/verify_auth_http.py`
(registration, refusals, logout, rate limit). Verification and login after
verification cannot be exercised from a browser until stage 7 delivers mail.

**Used in:** index.ts, csrf.ts, json.ts and transport.spec.ts. See
[the transport contract](../../../../../../../src/modules/identity/transport/http/CONTRACT.md)
and [the local adapters](../../infra/local/README.md).
