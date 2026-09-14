# Identity HTTP transport contract

**Stage:** implemented and verified on the real process in every build on
2026-09-13. This identity-owned transport registers the authentication
routes of AUTHENTICATION.md on the shared HTTP boundary (feature-route section
H15–H19), decodes requests, calls the stage 4 application operations, and encodes
responses. It owns cookie policy, origin, CSRF and WebSocket admission and the
mapping from an authenticated principal to provenance attribution. It contains no business
rule, no SQL and no crypto beyond the shared keyed digest.

## Configuration

R01 — Root supplies: the session cookie name and the CSRF cookie name (production
`__Host-n2f_session` and `__Host-n2f_csrf`; local HTTP development uses
explicitly different unprefixed names), whether cookies are Secure (refusing
insecure cookies unless an explicit development flag is set and the bind host is
loopback), the exact allowed-origin list (scheme, host, port; no wildcard), the
CSRF key (through the shared keyed digest, at least 32 bytes), the CSRF lifetime
(default one hour, maximum one hour), and the session absolute lifetime used for
the cookie Max-Age. Invalid configuration is Invalid `identity.transport_configuration`.

## Routes

R02 — Registered routes, all under `/v1/auth`, all returning `Cache-Control:
no-store`, all JSON bodies decoded strictly (unknown members, duplicate keys and
wrong types are 400 `http.invalid_body`):

| Method and path | Admission | Body | Result |
| --- | --- | --- | --- |
| GET /csrf | anonymous or session | none | 200 `{"csrf_token": …}` and a fresh CSRF cookie |
| POST /register | origin + CSRF | `{email, password}` | 202 `{"accepted": true}` |
| POST /email/verification-requests | origin + CSRF | `{email}` | 202 `{"accepted": true}` |
| POST /email/verify | origin + CSRF | `{token, password}` | 204 |
| POST /login | origin + CSRF | `{email, password}` | 200 `{principal_id, absolute_expires_at_ms, idle_expires_at_ms}`, session cookie, rotated CSRF cookie and token |
| GET /session | session required | none | 200 `{principal_id, auth_epoch}` |
| POST /websocket-ticket | session + origin + CSRF | none | 200 `{ticket, expires_at_ms}`; single-use 30-second ticket |
| POST /logout | session optional, origin + CSRF | none | 204, session cookie cleared, CSRF rotated |
| POST /logout-all | session required, origin + CSRF | none | 204, cookies cleared |
| POST /password/change | session required, origin + CSRF | `{current_password, new_password}` | 204, cookies cleared |
| POST /password/reset-requests | origin + CSRF | `{email}` | 202 `{"accepted": true}` |
| POST /password/reset | origin + CSRF | `{token, password}` | 204 |

`POST /websocket-ticket` issues a session-bound, single-use ticket. The raw ticket
is returned only in this response and is carried at upgrade in
`Sec-WebSocket-Protocol: n2f.v1, n2f.ticket.<ticket>`; it is never stored or put
in a URL. GET never consumes a token or changes state. Verification and reset
tokens arrive in bodies, never in URLs.

## Cookies

R03 — The session cookie carries the raw session secret exactly as the codec
issued it, with Path=/, HttpOnly, Secure per R01, SameSite=Lax, no Domain, and
Max-Age equal to the session absolute lifetime. Clearing uses Max-Age=0 with the
same attributes. A request carrying the session cookie name more than once is
refused with 401 `identity.session_rejected` before any lookup. Cookie values are
never logged and never echoed.

R04 — The CSRF cookie holds `nonce.issued_at_ms.tag`: a 16-byte random nonce
from the injected entropy, base64url unpadded; the issue time in decimal; and the
base64url unpadded tag from the keyed digest with purpose `csrf` over
`nonce || 0x00 || issued_at_ms || 0x00 || binding`, where binding is the hex of the
current session token digest when a valid session cookie accompanied the
issuance and the literal `anonymous` otherwise. The cookie stays HttpOnly
because the same string is returned in the response body as `csrf_token`; it
carries Path=/, Secure per R01, SameSite=Lax and Max-Age equal to the CSRF
lifetime. A script never needs to read the cookie.

## Admission

R05 — Origin: every POST requires exactly one Origin header whose value equals an
entry of the allowed-origin list; missing, repeated or unlisted is 403
`identity.origin_rejected`. GET routes do not check Origin.

R06 — CSRF: every POST requires the CSRF cookie exactly once and the
X-CSRF-Token header exactly once, byte-equal to each other; the tag must verify
under the binding derived from the request's current session state (the digest of
the presented session cookie when one is present and resolves, otherwise
`anonymous`); the issue time must be within the CSRF lifetime of now. Any
failure is 403 `identity.csrf_rejected`. A CSRF context issued anonymously is not
valid for a session-bound request and vice versa; login and logout therefore
rotate the context and return the fresh token.

R07 — Session: routes marked "session required" run the Authenticate query in the
H17 admission step with the session cookie's value; a missing, duplicated,
malformed, expired or revoked cookie is 401 `identity.session_rejected` with the
session cookie cleared. A successful admission yields the AuthenticatedPrincipal
as the admitted value and the attribution `initiator = user actor whose identity
is the principal ID`, executor the root's service actor. "session optional" (logout) admits anonymously when no cookie is present and
rejects as above when an invalid one is present. Anonymous routes and GET /csrf
resolve a presented session cookie only to bind the CSRF context; when it does
not resolve they proceed anonymously rather than refusing. Anonymous routes never
derive an initiator from any header or body field; a claimed email is not an
identity (A19).

R08 — Rate-limit refusals from the application (`identity.auth_rate_limited`)
are projected as 429 with Retry-After in whole seconds (ceiling, minimum 1)
derived from the failure's public `retry_after_ms` field, through the shared
boundary's headers-carrying refusal.

## Responses

R09 — Registration, verification-request and reset-request return 202 with the
same body for created, duplicate, absent, already-verified and stale outcomes,
and whether mail was delivered is never disclosed. Only a malformed body (400),
an invalid password policy (400 `identity.password_invalid`), origin/CSRF
refusal (403), rate limiting (429) and dependency failure (503) differ.

R10 — Login returns one refusal, 401 `identity.credentials_rejected`, for
unknown email, wrong password, unverified email and suspended principal. On
success it sets the session cookie, rotates the CSRF context bound to the new
session, and returns the safe projection; it never returns the token in the body.

R11 — Logout returns 204 even when no session is present or the session is
already inactive; it always clears the session cookie and sets a fresh anonymous
CSRF cookie. A 204 carries no body, so the client fetches GET /csrf before its
next unsafe request; only GET /csrf and login return a token in a body. Logout-all and password change clear the cookies and
return 204; the client must log in again.

R12 — All identity refusals keep their public type and kind through the shared
problem projection; transport adds no message that reveals which field or proof
failed. Uncertain commits and dependency failures are 503 with their kinds.

R12a — The WebSocket upgrade boundary requires exactly one allowed Origin, one
session cookie, the `n2f.v1` protocol and one `n2f.ticket.<ticket>` protocol
value. It authenticates the cookie, atomically consumes the ticket while
rechecking the session and auth epoch, and passes only the safe principal
projection plus an opaque private session proof to the socket owner. Missing,
malformed, expired, replayed or revoked admission is refused before the
protocol upgrade. The socket adapter invokes identity revalidation before each
authenticated message and on its heartbeat; revoked, expired or epoch-stale
sessions close with policy violation before protected work runs.

## Provenance and observation

R13 — The transport supplies the fixed provenance operation name per route
(`identity.http.<route>`) at registration. Completion observation is the shared
boundary's; the transport adds no request or response logging and never places
tokens, cookies, passwords, emails or CSRF values in logs, spans, metrics or
problem documents.

## Verification

R14 — Executable specs run the transport on the real shared HTTP adapter with
the application operations wired to fakes (in-memory store, recording mail,
permissive limiter, fixed clock and IDs, real hasher with tiny limits, real codec
with fixed entropy): every route's happy path and every refusal row above;
duplicate session cookie refused before lookup; CSRF cookie/header mismatch,
expired context, anonymous context on a session-bound route and session context
on an anonymous route all refused; Origin missing, repeated and unlisted refused;
malformed and unknown-member bodies refused; login rotates CSRF and sets the
cookie with every attribute; logout idempotent and clearing; authenticated
requests carry the user initiator in the scope while anonymous ones do not;
no private value in the completion log; responses carry no-store.

R15 — Selected mutations: origin check skipped, CSRF binding ignored (anonymous
token accepted for a session request), CSRF lifetime unchecked, duplicate
session cookie tolerated, login response includes the token, and refusal detail
reveals which credential field failed.

## Native shapes

Go (`internal/identity/transport/http`): `New(Config, Deps) (*Transport, error)`;
`(*Transport).Routes() []nethttp.Route`; Deps carries the stage 4 operation
values and the keyed digest, entropy and clock.

Rust (`domains::identity::transport::http`): `Transport::new(Config, Deps) ->
Result<Transport, Failure>`; `fn routes(&self) -> Vec<Route>`.

TypeScript (`modules/identity/transport/http`): `createTransport(config, deps):
Result<{ routes: Route[] }, Failure>`.
