# TypeScript: auth leaves at the JavaScript boundary

**Origin:** implementing the auth leaf specs (A01–A09) green on 2026-09-12 against
the refusing scaffolds, then confirming six named mutations by hand.

`String.prototype.isWellFormed` exists in Node 22 but not in the ES2023 compiler
lib this build targets: vitest ran green through esbuild while `tsc` and
`nest build` refused. Rather than raise the lib for one call, `bounds.ts` scans by
code point; a paired surrogate iterates as one value above 0xffff and a lone one
as its own code unit, so a surrogate-range test finds exactly the malformed cases.
The lesson is that a vitest pass is not a type-check pass in this repository.

Redaction is per class, not inherited by containment. `Email` extends
`SecretString` and inherits its hooks, but `NewPassword`, `PasswordInput` and
`TokenDigest` wrap a private field: without their own `toString`, `toJSON`,
`Symbol.toPrimitive` and `inspect.custom`, `JSON.stringify` printed `{}` and the
spec's `[REDACTED]` marker was missing. The secret_disclosure mutation adds a
`toJSON` override to `Email` because `String(v)` goes through `Symbol.toPrimitive`
first; overriding only `toString` would not change any observed output.

Private constructors do not survive `Reflect.construct`, as the principal leaf
already showed. Every transition here therefore re-normalizes `#state` before
reading it, and `TokenDigest.valid` / `Email.valid` re-check the instance's own
contents rather than trusting `instanceof`. The cost is one extra validation per
operation; the alternative, validating only in `restore`, was the erased-privacy
bug from the previous stage.

Absent timestamps are omitted keys, not `undefined` values. Both satisfy
`toEqual`, but omitting the key keeps a later SQL boundary from writing an
explicit `undefined` and keeps `null` a malformed input rather than a synonym.

`touch` refuses an idle TTL above the common time ceiling before it considers
the absolute cap. Capping `now + Number.MAX_SAFE_INTEGER` to the absolute expiry
would have made an overflowing TTL look successful; the spec calls it invalid.

**Used in:** bounds.ts, email.ts, password.ts, token.ts, credential.ts,
auth-state.ts, session.ts and challenge.ts. See the auth contract and
[authentication boundaries](authentication-boundaries.md).
