# SMTP mail delivery: one bound, one transport per message

**Origin:** implementing the stage 7a SMTP contract (M10–M16) spec-first on
2026-09-12, then running the process verifier against Mailpit.

nodemailer's `connectionTimeout`, `greetingTimeout` and `socketTimeout` each
bound one phase, so together they allow roughly three budgets before a stalled
server is abandoned. The contract bounds the whole attempt, so the adapter also
races the send against one outer timer. Both read a single budget field; the
`timeout_ignored` mutation replaces that field and the stalled-server spec fails
by exceeding its own deadline. In the stall case either the greeting timeout or
the outer timer can win, and both classify as `timeout`.

A transport is created per message instead of once at construction. A long-lived
transport keeps the revealed SMTP password inside the library's options object
for the life of the process; per message, the password is handed over only for
that attempt (M14), and each send is exactly one connection (M12).

Outcomes come from the library's error shape: a server reply carries
`responseCode`, which is `refused`; `ETIMEDOUT` or the outer timer is `timeout`;
a refused connection carries no reply code and is `failed`. The reply text is
never logged, so a 5xx message cannot leak into the attempt log.

The shared env reader has no optional-secret method: `string` would record the
SMTP password unredacted in the manifest, and `secret` refuses an empty value.
Root therefore reads `AUTH_SMTP_PASSWORD` as a secret only when a username is
set, and detects a stray password through the raw lookup so its value is never
recorded; composition then refuses. The `AUTH_SMTP_*` and link settings are read
only when `AUTH_SMTP_HOST` is set, so the manifest lists them conditionally.

`new URL(origin).origin === origin` rejects a trailing slash, a path, a query, a
fragment, embedded credentials and non-special schemes (whose origin is `null`)
in one comparison; `http` is then allowed only for a loopback link host.

The spec's fake SMTP peer undoes dot-stuffing and decodes the declared transfer
encoding before asserting on the body, rather than assuming 7-bit text, so a
soft line break inside the link cannot make the assertion depend on the
library's encoding choice.

nodemailer is pinned at 10.0.8, which bundles its own types. 10.0.9 was younger
than pnpm's minimum release age, and installing it silently wrote a
`pnpm-workspace.yaml` exclusion; that version and the exclusion were dropped.

A principal that is not active now gets no verification or reset challenge and
no mail, with the same private `accepted` response (outcome `inactive`). The HTTP
surface has no suspension route, so only the application spec exercises it.

**Limits:** real TLS (`starttls`, `tls`) and SMTP authentication against a
non-local server are unverified; the specs use a plaintext fake peer and the
verifier uses Mailpit without TLS or credentials. Six selected mutations were
caught in place with hash-verified restoration; no isolated-copy evidence was
recorded for this stage yet.

**Used in:** index.ts, smtp.spec.ts, src/root/auth.ts and
src/modules/identity/app/command/request-challenge.ts. See
[the SMTP contract](../../../../../../../src/modules/identity/infra/smtp/CONTRACT.md)
and [local adapters](../local/README.md).
