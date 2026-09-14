# TypeScript: built-in Argon2 behind a promise queue

**Origin:** implementing the password hashing contract (H01–H10) spec-first on
2026-09-12 under Node 24, then confirming seven named mutations by hand.

Node 24 ships `crypto.argon2` on OpenSSL 3.5, so no native npm module is needed.
The session shell still resolved Node 22, where the function is absent: every
check for this adapter runs with the `.nvmrc` version on PATH, and package.json
now declares `engines.node >= 24.19.0`. The callback form is wrapped in a promise
so the derivation runs on the libuv threadpool; the synchronous form would block
the event loop for the whole 19 MiB, two-pass computation.

The allowlist is a string comparison, not a parser. The record is split on `$`
and each field is compared to the single supported literal, so `m=` is never read
as a number and the built-in is always called with the fixed parameters. The
`allowlist_memory` mutation therefore produces a mismatch rather than a 4 GiB
allocation attempt, which is why a lenient parser that forwarded parameters to
the library would be the dangerous variant.

`Buffer.from(text, 'base64')` silently ignores characters outside its alphabet
and accepts missing padding. Strict PHC B64 needs an explicit alphabet test, an
exact byte length and a re-encode comparison; the padded and truncated tag
fixtures fail only because of the round trip, not the decode.

The admission gate is a counter plus an array of waiters, not a library
semaphore. A queued caller owns its own timer and abort listener and removes
itself from the queue before settling, so a timed-out or canceled waiter never
receives a slot later. Release hands the slot to the next waiter directly instead
of decrementing and re-acquiring, which keeps `active` exact under interleaving.
The `AbortSignal` is consulted only while queued; once admitted the derivation
runs to completion and its result is returned (H07), because there is no way to
stop the threadpool work already started.

The test seam is a module-scoped `make` bound inside a `static {}` block. The
constructor stays TypeScript-private, `PasswordHasher.create` binds the real
derivation, and `createHasher` (exported from `hasher.ts` but not from the
package index) lets admission tests inject a gated promise. A symbol-keyed static
was tried first and rejected as harder to type than the static block.

**Limits:** interoperability rests on the checked-in vectors, which Node
reproduced byte for byte. Seven selected mutations were caught in place with
hash-verified restoration. No application operation, storage or transport uses
this adapter yet, and constant-time behavior is inherited from
`timingSafeEqual`, not measured.

**Used in:** phc.ts, admission.ts, hasher.ts, index.ts and password-hash.spec.ts.
See the [contract](../../../../../../src/modules/identity/password-hash/CONTRACT.md).
