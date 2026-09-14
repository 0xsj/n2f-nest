# Identity local adapters contract

**Stage:** implemented and mutation-checked in every build on 2026-09-12. Three
small identity-owned adapters let root compose a
runnable authentication process before stage 7 supplies the shared Redis limiter
and Mailpit delivery. Each implements a stage 4 port. None is production
protection and each says so in its type name and documentation.

## Process-local attempt limiter

L01 — `Admit(operation, subject, source)` counts attempts per key inside one
process with a fixed window per operation: the key is the keyed digest (purpose
`rate_limit`) over `operation || 0x00 || subject` for the subject bucket and over
`operation || 0x00 || source` for the source bucket; raw subjects and sources are
never stored or logged. Both buckets must be under their limits for a permit;
refusal reports the remaining window as retry-after milliseconds. The counter is incremented on every admit call, permitted or not, so refused
subject attempts also drain the source budget. An operation name without
configured limits is a wiring fault and refuses admission (no fail-open); the
builds report it as Unavailable `identity.auth_dependency_failed` or Invalid
`identity.limiter_configuration`, and neither permits.

L02 — Limits are constructor configuration per operation: attempts per window
and window length, for subject and source separately. Defaults: register 5 per
15 min by subject and 30 per 15 min by source; login 10 per 15 min by subject and
100 per 15 min by source; verification_request, reset_request 3 per 15 min by
subject and 30 per 15 min by source; verify, reset 10 per 15 min by subject;
password_change 5 per 15 min by subject. Zero or negative limits are Invalid
`identity.limiter_configuration`.

L03 — The store is bounded: at most a configured number of keys (default 100000)
with expired windows evicted on access; when full, admission fails with
Unavailable `identity.auth_dependency_failed` rather than silently permitting
(A16: no fail-open). The clock is injected. This adapter provides no protection
across processes or restarts and is not the stage 7 deliverable.

## File-backed enrollment policy

B01 — `CheckBlocklist(NewPassword)` returns refused when the NFC-normalized
password equals, case-insensitively under simple Unicode folding, any entry of a
root-supplied newline-separated list read once at construction; blank lines and
lines beginning with `#` are ignored; entries are NFC-normalized when loaded.
Comparison is exact, not substring. The list's line count is reported for the
root manifest; its contents never are.

B02 — A missing or unreadable file, or an empty list, is Invalid
`identity.blocklist_configuration` at construction: a silent empty list would
turn the policy off. Root ships a small development list and documents that it
is not production coverage (A02).

## Undelivered mail

M01 — `SendVerification` and `SendReset` return delivered=false without error
and without any external effect; they record only a safe counter per kind. The
token and email are neither logged nor retained. Root uses this adapter only
when no SMTP configuration is supplied, and the process manifest states that
mail is disabled. Stage 7 replaces it with Mailpit delivery.

## Verification

V01 — Specs cover: subject and source buckets counted independently, permit
until the limit and refusal after it with a correct retry-after, window expiry
resets, eviction under the key bound and Unavailable when full, keyed digest use
(the raw subject never appears in the adapter's state), blocklist matches with
NFC and case folding, comment and blank handling, empty-list refusal, and the
mail adapter's non-delivery with no retained token.

V02 — Selected mutations: source bucket ignored, retry-after zero on refusal,
fail-open when full, blocklist substring match, empty list accepted, mail
adapter retains the token.

## Native shapes

Go (`internal/identity/infra/local`): `NewLimiter(keyed *keyed.Digest, clock, LimiterConfig)`,
`NewBlocklist(path string) (*Blocklist, error)`, `UndeliveredMail{}`.
Rust (`domains::identity::infra::local`): `Limiter::new(...)`, `Blocklist::load(path)`,
`UndeliveredMail`. TypeScript (`modules/identity/infra/local`): `createLimiter`,
`loadBlocklist`, `undeliveredMail`.
