# Authentication process: composition and run guide

**Stage:** implemented and verified on the real process in every build on
2026-09-13, including SMTP delivery and the shared Redis limiter. This guide is
the composition contract for stages 6–8 of [AUTHENTICATION.md](AUTHENTICATION.md):
root assembles the identity store, crypto adapters, local or Redis limiter,
application operations and HTTP transport into the existing diagnostic process.
Mail is delivered over SMTP when the `AUTH_SMTP_*` settings are supplied and is
disabled otherwise. WebSocket tickets are issued through HTTP and admitted by
the native upgrade boundary.

## Settings

All settings are read once through the shared env reader; secrets use the secret
type and never appear in the manifest or logs. `AUTH_ENABLED=true` requires
`DATABASE_ENABLED=true`.

| Variable | Default | Meaning |
| --- | --- | --- |
| AUTH_ENABLED | false | Register the identity routes and adapters |
| AUTH_COOKIE_SECURE | true | Secure attribute on both cookies; `false` is accepted only with AUTH_DEV_INSECURE_COOKIES=true and a loopback HTTP_HOST |
| AUTH_DEV_INSECURE_COOKIES | false | Explicit development opt-in for insecure cookies |
| AUTH_SESSION_COOKIE | `__Host-n2f_session` (`n2f_session` when insecure) | Session cookie name |
| AUTH_CSRF_COOKIE | `__Host-n2f_csrf` (`n2f_csrf` when insecure) | CSRF cookie name |
| AUTH_ALLOWED_ORIGINS | required | Comma-separated exact origins for POST admission |
| AUTH_CSRF_KEY | required, secret | Keyed-digest key, at least 32 bytes |
| AUTH_CSRF_TTL_MS | 3600000 | CSRF context lifetime, at most 3600000 |
| AUTH_SESSION_ABSOLUTE_MS | 43200000 | Session absolute lifetime |
| AUTH_SESSION_IDLE_MS | 1800000 | Session idle lifetime |
| AUTH_VERIFICATION_TTL_MS | 86400000 | Verification challenge lifetime |
| AUTH_RESET_TTL_MS | 900000 | Reset challenge lifetime |
| AUTH_HASH_MAX_CONCURRENT | 2 | Hasher admission slots |
| AUTH_HASH_MAX_QUEUED | 16 | Hasher queue length |
| AUTH_HASH_QUEUE_WAIT_MS | 2000 | Hasher queue wait |
| AUTH_LIMITER | local | `local` for process-local state, `redis` for shared state |
| AUTH_LIMITER_REDIS_URL | required in redis mode, secret | `redis://` endpoint; unsupported TLS/cluster URLs are refused |
| AUTH_LIMITER_TIMEOUT_MS | 500 | Redis command timeout |
| AUTH_LIMITER_MAX_KEYS | 100000 | Maximum live Redis limiter buckets |
| HTTP_TRUSTED_PROXIES | empty | Comma-separated trusted proxy IPs/CIDRs; forwarded headers are ignored otherwise |
| AUTH_BLOCKLIST_PATH | required | Newline-separated blocked passwords; `config/password-blocklist.txt` ships as a development list |
| AUTH_SMTP_HOST | empty | SMTP host; empty keeps mail disabled with the undelivered adapter |
| AUTH_SMTP_PORT | 587 | SMTP port |
| AUTH_SMTP_SECURITY | starttls | `none`, `starttls` or `tls`; `none` only for a loopback host |
| AUTH_SMTP_USERNAME | empty | SMTP username; requires AUTH_SMTP_PASSWORD |
| AUTH_SMTP_PASSWORD | empty, secret | SMTP password; requires AUTH_SMTP_USERNAME |
| AUTH_SMTP_TIMEOUT_MS | 5000 | Bound on one delivery attempt |
| AUTH_MAIL_FROM | required with a host | From address |
| AUTH_MAIL_FROM_NAME | n2f | From display name |
| AUTH_LINK_ORIGIN | required with a host | Frontend origin for mail links; `https` unless loopback |
| AUTH_VERIFY_PATH | /verify-email | Verification link path |
| AUTH_RESET_PATH | /reset-password | Reset link path |

Invalid or missing required settings refuse startup with the shared env failure
types; the manifest lists every auth setting by name with secrets redacted, the
blocklist line count, `auth.mail=smtp` or `auth.mail=disabled`, and
`auth.limiter=process_local` or `auth.limiter=redis`. The Redis URL and password,
SMTP host, username, password, From address and link origin never appear in it
beyond their setting names. When AUTH_SMTP_HOST is empty the other mail settings
are not read and need not appear; a password supplied without a username is
refused at startup rather than ignored, and root detects it without recording
its value.

## Wiring order

1. Open the database and apply the ledger: events migration as version 1,
   identity migration as version 2.
2. Construct the identity store on the shared database; the password hasher on
   the OS entropy source with the configured limits; the token codec on the same
   entropy; the keyed digest on the CSRF key; the selected local or Redis
   limiter on the keyed digest and wall clock; the file-backed blocklist; the
   SMTP mailer when a host is configured, otherwise the undelivered mail adapter.
3. Construct the application operations with the store narrowed per operation,
   the adapters wrapped into their ports at root (hasher outcome to bool, codec
   issued pair), the wall clock, the UUIDv7 generator and the lifetimes above.
4. Construct the identity HTTP transport with the cookie, origin and CSRF
   settings and register its routes together with the diagnostic routes.
5. Root's scope opener uses the admission's attribution when present and the
   anonymous default otherwise; the executor is the root service actor.
6. Shutdown order is unchanged: stop admission, drain HTTP, then close the
   database and telemetry within the single budget.

Readiness is unchanged; auth adds no probe. Root never logs bodies, cookies,
tokens or emails; the transport contract already forbids them in problem
documents and completion logs.

## Running locally

```
docker compose up -d --wait postgres redis mailpit
AUTH_ENABLED=true DATABASE_ENABLED=true DATABASE_URL=postgres://n2f:n2f_local@127.0.0.1:<postgres port>/n2f \
AUTH_DEV_INSECURE_COOKIES=true AUTH_COOKIE_SECURE=false \
AUTH_ALLOWED_ORIGINS=http://127.0.0.1:<http port> AUTH_CSRF_KEY=<at least 32 random bytes> \
AUTH_BLOCKLIST_PATH=config/password-blocklist.txt HTTP_PORT=<http port> \
AUTH_SMTP_HOST=127.0.0.1 AUTH_SMTP_PORT=<smtp port> AUTH_SMTP_SECURITY=none \
AUTH_MAIL_FROM=no-reply@n2f.local AUTH_LINK_ORIGIN=http://127.0.0.1:<http port> \
<the http-example command of this build>
```

For shared rate limits, set `AUTH_LIMITER=redis` and
`AUTH_LIMITER_REDIS_URL=redis://127.0.0.1:<Redis port>`. Keep `AUTH_LIMITER=local`
for offline development and deterministic process-local tests.

Then, from a client that sends `Origin: http://127.0.0.1:<http port>`, call
`GET /v1/auth/csrf`, send its `csrf_token` back as `X-CSRF-Token` with the
cookie jar, and `POST /v1/auth/register`. Verification and reset mail arrive in the local Mailpit inbox (see
INFRASTRUCTURE.md for its port); the link's fragment carries the token a
frontend page submits with a POST. `tools/verify_auth_http.py` walks the whole
flow.

## Process verification

`python3 tools/verify_auth_http.py` starts the owned check PostgreSQL project,
creates a disposable database, starts this build's process with the settings
above on a fixed loopback port, and asserts with a plain HTTP client: the manifest names the auth settings without secrets and reports mail as smtp;
`GET /v1/auth/csrf` returns 200, a token and a CSRF cookie; a POST without
Origin is 403 `identity.origin_rejected`; with a mismatched X-CSRF-Token 403
`identity.csrf_rejected`; a malformed body is 400; a blocklisted password is 400
`identity.password_invalid`; registration is 202 and a second registration of
the same email is also 202; a wrong-password login and a login before
verification are both 401 `identity.credentials_rejected` with identical bodies
apart from IDs; `GET /v1/auth/session` without a cookie is 401; `POST
/v1/auth/logout` without a session is 204 and clears the cookie; the sixth
registration attempt for one email within the window is 429 with Retry-After;
exactly one verification mail arrives with the token only in the link fragment;
a wrong-password verification is 401 `identity.challenge_rejected`, the correct
one is 204 and its replay is 401; login is 200 with the session cookie and no
token in the body; `GET /v1/auth/session` is 200 and 401 after logout; a reset
request is 202 and delivers a reset mail, a request for an unknown email is 202
and delivers none; the reset is 204, the old password is then refused and the
new one logs in; the outbox holds one registration, one verification, one
logout revocation, one password change, one all-sessions revocation and two
session-creation facts; readiness stays 200; the process exits 0 on
SIGTERM within the budget; and neither the password sentinels, the email, the CSRF key nor any mailed token or
session cookie value appears in any process output. The tool prints evidence JSON and tears
the check project down.

Every registration, login refusal and logout above must also appear as exactly
one `http.request.completed` log with the route template and no cookie value.

`python3 tools/verify_limiter.py` starts two independent HTTP processes against
one disposable Redis instance and proves that their combined login attempts
share the same refusal window. It also verifies digest-only Redis state and
redaction of the limiter secret.
