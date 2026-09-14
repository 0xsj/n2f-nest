# Built-in identity and authentication

**Stage:** browser workflow complete. Stages 1–6 and the mail delivery half of
stage 7 are implemented and mutation-checked: leaves, crypto adapters, application
operations, the PostgreSQL store, the `/v1/auth` routes with cookies, origin and
CSRF admission, root composition, and SMTP delivery. The real process walks
register, verify, login, session, logout and reset against Mailpit. The shared
Redis limiter and trusted-proxy policy are implemented and real-broker verified;
the redaction review and WebSocket ticket/admission slice are implemented and
real-process verified. The first audit ingestion slice is also implemented and
real-broker verified; selected audit and limiter mutations are caught, and full-suite
evidence still remains.

Authentication ships with this blueprint. A profile/account domain is not a
prerequisite. Identity owns principals, login identifiers, password credentials,
sessions and recovery challenges. Org owns memberships and scoped authorization;
audit owns durable business records; root translates their capabilities.

## Baseline and boundaries

Working client baseline: email/password and opaque server-side sessions carried by
browser cookies. This is an implementation default, not a claim that all Flover
clients were inspected. A future bearer transport can resolve the same session
capability; native clients, OIDC, passkeys, MFA and service credentials are separate
extensions. A human login must never create a service principal.

Registration, email verification, login, current-session lookup, logout,
logout-all, password change and password reset are required for the auth milestone.
Suspension must invalidate existing sessions. HTTP and WebSockets must establish
authenticated attribution through identity, with audit facts for state changes.
DisplayName remains the existing principal label for now; extracting a profile
must not gate authentication or silently change the principal contract.

## Leaf-first build order

1. Specify credential/session/challenge rules and native API shapes (done).
2. Write comparable executable leaf specs, observe meaningful red, implement pure
   values and transitions, then run selected mutations and record mirrored notes (done).
3. Implement identity-owned PasswordHasher and TokenCodec adapters (done). Use maintained
   crypto libraries, bounded work and interoperability vectors across the builds.
4. Implement register/verify/login/authenticate/revoke/change/reset application
   operations with fake consumer-owned ports. No ORM, HTTP or crypto SDK types (done).
5. PostgreSQL migrations and concrete atomic operations (done). Verify unique login races,
   credential-version races, challenge replay, revocation and uncertain commit.
6. Extend bounded HTTP beyond its current diagnostic GET/HEAD surface (done). Add methods,
   bounded bodies, selected headers, response headers/status and cookies while
   preserving once-only completion observation. Add auth admission and real routes.
7. Wire Mailpit delivery and shared Redis auth rate limits (done), with a root-owned
   trusted-proxy policy; complete the redaction review and verify the entire
   browser workflow and failure paths.
8. Authenticate WebSocket admission and revalidate ongoing use (done). Translate identity
   outbox facts into audit with consumer-specific deduplication (first slice done;
   real-broker evidence and selected mutation evidence pass; full-suite evidence
   remains). Compare PostgreSQL and JetStream delivery. The org organization,
   membership, create application and PostgreSQL persistence slices are now done;
   the root-composed authenticated org create route is done; broader membership
   policy is next.

Each stage updates current status; a passing principal or session unit suite does
not satisfy the auth milestone. No account/profile placeholder is needed.

## Intended HTTP surface

All routes below are planned. JSON bodies are bounded and decoded strictly; tokens,
passwords and email addresses are excluded from generic request logging.

| Method/path | Meaning | Normal result |
| --- | --- | --- |
| GET /v1/auth/csrf | Establish anonymous browser CSRF context | 200, readable CSRF token |
| POST /v1/auth/register | Create pending email/password identity | 202 generic accepted |
| POST /v1/auth/email/verification-requests | Request/resend verification | 202 generic accepted |
| POST /v1/auth/email/verify | Consume verification token plus password proof | 204; no login |
| POST /v1/auth/login | Verify credentials and issue fresh session | 200 safe identity + cookie |
| GET /v1/auth/session | Resolve current authenticated principal | 200 safe identity |
| POST /v1/auth/websocket-ticket | Issue session-bound single-use upgrade ticket | 200 secret ticket |
| POST /v1/auth/logout | Revoke current session and clear cookie | 204, idempotent |
| POST /v1/auth/logout-all | Invalidate all principal sessions | 204 |
| POST /v1/auth/password/change | Verify current password, replace credential | 204, sessions invalidated |
| POST /v1/auth/password/reset-requests | Request recovery | 202 generic accepted |
| POST /v1/auth/password/reset | Consume recovery token and replace password | 204; no login |

GET never consumes verification/reset tokens or changes identity state. Mail links
open a frontend confirmation page; it submits a POST. Link origin comes from root
configuration, never the request Host header. Keep tokens out of API URLs, access
logs and third-party frontend assets; a frontend may extract a fragment then clear it.

Public registration and recovery responses must not disclose whether an email
exists. Malformed request shape, admission throttling and infrastructure failure
remain distinguishable from an accepted request. Login returns one credential
refusal for unknown email, wrong password, unverified email or suspended principal.
Do not promise mathematically constant request duration; require comparable bounded
hashing paths and measure the observable behavior.

## Browser and realtime admission

Production cookie: __Host-n2f_session; Secure; HttpOnly; SameSite=Lax; Path=/; no
Domain. Local HTTP development uses an explicitly separate unprefixed cookie name;
production configuration must refuse insecure cookies. Cross-site cookie deployment
is not enabled by silently weakening these settings: prefer a same-site API or BFF.
Responses containing credentials or identity use Cache-Control: no-store.

CSRF protection covers login and all unsafe cookie routes, including anonymous
registration/recovery. Root supplies an exact origin allowlist; cookie routes require
a matching Origin and a signed double-submit CSRF cookie/header pair with a maximum
one-hour lifetime, bound to the current session token digest when authenticated.
Rotate the CSRF context at login/logout; the client obtains a fresh token before
its next unsafe request. Anonymous contexts use an independent random nonce.
Reject duplicate
session cookies and conflicting credential sources. Never use wildcard credentialed
CORS. SameSite is additional protection, not the complete CSRF control.

Browser WebSockets use the session cookie at upgrade, require an allowed Origin and
a short-lived single-use upgrade ticket obtained through a CSRF-protected POST.
The ticket is carried in the agreed subprotocol field, never URL query, and is
excluded from logs. Authorization still belongs to each message's application
consumer. Revalidate before accepting authenticated messages and before protected
outbound delivery; an idle periodic check closes revoked/expired connections.
A connection opened earlier is not indefinite proof of session validity.

Root maps an authenticated human principal to provenance's user actor, with the
service as executor. Caller-supplied actor/tenant headers cannot override it.
Anonymous auth attempts remain anonymous; a claimed email is not an initiator ID.
A reset token grants only its recovery operation, not a general authenticated scope.

## Milestone evidence required

- All three builds pass the same behavior fixtures; policy and wire fields agree.
- Cross-language password vectors verify; malformed/oversized hash records refuse
  before expensive allocation; hash work has an admission bound.
- Real PostgreSQL proves rollback and concurrent single-use/CAS outcomes.
- Real HTTP proves CSRF, cookies, enumeration-safe bodies, login/logout/recovery,
  auth-derived provenance, rate limits and once-only completion observation.
- Mailpit proves the intended verification/reset link and no token in logs.
- WebSockets reject unauthenticated admission and stop protected work after expiry
  or revocation under the defined per-operation check.
- Audit consumes committed facts idempotently through both publisher adapters.
- Targeted mutations exercise expiry equality, purpose confusion, replay, stale
  credential version, missing revocation checks and secret disclosure.

## Local specifications

- [Behavior contract](src/modules/identity/domain/AUTH_CONTRACT.md).
- [Native API and executable-spec map](src/modules/identity/domain/AUTH_API.md).
- [Logical storage schema](src/modules/identity/domain/AUTH_SCHEMA.md).
- [Decision 0011](decisions/0011-identity-includes-credentials-and-revocable-sessions.md).
