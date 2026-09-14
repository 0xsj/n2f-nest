# Identity SMTP mail delivery contract

**Stage:** implemented and verified against Mailpit in every build on 2026-09-12.
This identity-owned adapter implements the stage 4
MailDelivery port for verification and password-reset messages over SMTP. Root
uses it when SMTP settings are supplied and the undelivered adapter otherwise.
It builds messages and talks SMTP; it decides nothing about who receives mail.

## Configuration

M10 — Root supplies: SMTP host (1..253 characters); port (1..65535); security
`none`, `starttls` or `tls`; an optional username and secret password, both or
neither; the From address, validated as a login email; an optional From display
name of at most 64 printable ASCII characters without quotes, angle brackets,
backslashes or line breaks (default `n2f`); the link origin, an absolute `https` origin with no path, query, fragment or
credentials (`http` is accepted only when the link origin's own host is
loopback); the verification and reset link paths (default `/verify-email` and
`/reset-password`, each starting with `/` and containing no `?` or `#`); and an
operation timeout of 1..30000 ms (default 5000). Security `none` is accepted only for a loopback SMTP host; because `starttls`
and `tls` both provide TLS, this is also the only case of credentials without
TLS. A username without a password, or a password without a username, is
refused. Anything else is Invalid `identity.mail_configuration` at construction.

## Message

M11 — Each message has exactly one recipient, the canonical email; the
configured From; the fixed Subject `Verify your email address` or `Reset your
password`; and a UTF-8 plain-text body with no HTML part in this slice. The body
states the purpose in one sentence, gives the link, and states the expiry as an
ISO 8601 UTC timestamp derived from the expiry milliseconds. The link is exactly
`<origin><path>#token=<secret>`: the token travels only in the fragment, never in
the path or query, so it does not reach any server log when the page loads.
Header values come only from configuration and the validated email; the SMTP
library builds and encodes the headers.

## Delivery

M12 — Each send opens one connection, negotiates the configured security,
authenticates when credentials are configured, and submits the message.
Delivered is true only when the server accepts the message after DATA. Connection
refusal, TLS or authentication failure, a rejected sender, recipient or message,
and exceeding the timeout (which bounds the whole attempt, connect included) are
all delivered false. The port never receives an error from this adapter, and it
never retries (A15).

M13 — Each attempt emits at most one safe log event, `identity.mail.attempted`,
with the message kind (`verification` or `reset`), the outcome and elapsed
milliseconds. The outcome is `delivered` when the server accepts the message,
`refused` when the server answers with a rejection reply, `timeout` when the
attempt bound expires, and `failed` for everything else, including a refused
connection and TLS or authentication failures that carry no server reply. The
From display name may be emitted as a quoted string because M10 already limits
it to printable ASCII. The token, link,
recipient, From address, credentials, SMTP replies and library error text never
appear in logs, errors or problem documents.

M14 — The token is revealed only to build the body and the password only to
authenticate; neither is retained after the call returns.

## Verification

M15 — Specs run the adapter against an in-test fake SMTP server that can accept,
reject with a 5xx reply, or stall. Required: one recipient, From, fixed subject,
plain-text body, link with the token only in the fragment, expiry text; delivered
true on acceptance; false on a 5xx rejection, a refused connection and a stall
within the timeout budget; the attempt log carries kind and outcome and no token,
link or recipient; configuration refusals for non-loopback `none`, credentials
without TLS on a remote host, a non-https remote origin, an origin with a path,
and a path containing `#`. Real Mailpit delivery is proven by the process
verifier.

M16 — Selected mutations: token_in_query (the link carries the token in a query
string), delivered_on_rejection (a 5xx reply reports delivered), timeout_ignored
(the timeout is not applied), token_in_log (the link or token reaches the attempt
log), and expiry_omitted (the body lacks the expiry).

## Native shapes

Go (`internal/identity/infra/smtp`): `New(Config, *slog.Logger) (*Mailer, error)`,
implementing `command.MailDelivery` with `net/smtp` over a dialer bounded by the
timeout.

Rust (`domains::identity::infra::smtp`): `Mailer::new(Config, Logger) ->
Result<Mailer, Failure>`, implementing the MailDelivery trait with `lettre`'s
tokio transport.

TypeScript (`modules/identity/infra/smtp`): `createMailer(config, logger):
Result<MailDelivery, Failure>` using `nodemailer`.
