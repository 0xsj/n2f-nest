# Result handles expected outcomes; unknown handles the throwing edge

A discriminated result keeps ordinary failure in the return type, while an
exception carrier crosses a boundary that genuinely expects a thrown value.

## The result discriminant

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

The literal `ok` boolean lets TypeScript narrow the available payload. `never`
in `ok<T>(value): Result<T, never>` and `err<E>(error): Result<never, E>` means
that helper creates only one branch; it is different from `undefined`, which can
be a legitimate successful value.

`mapError` returns success unchanged and invokes its mapper only for failure.
That branch distinction is tested directly rather than inferred from truthiness.

## Caught values are `unknown`

JavaScript can throw anything. `fromCaught` preserves a trusted failure, and
otherwise constructs an internal failure while retaining the exact unknown value
as a private cause. A caught `undefined` is still a failure; it must not be
confused with `ok(undefined)`.

## The exception carrier

`AppError` extends the native `Error` shape but registers its trusted failure in
a private carrier map. It is useful at a framework edge, while ordinary domain
and application code can keep returning `Result`.

The future Nest exception filter, HTTP response mapper or NATS adapter owns the
conversion from `AppError`/`Failure` to its wire representation. This package
does not decide status codes, envelopes or retry policy.

## Repository rule

The project applies this idea as an architectural boundary rather than as a
claim that JavaScript can never throw. Module and workflow `domain/` and `app/`
code must represent expected outcomes as `Result` values and must not contain
`throw` statements or `catch` clauses. Adapters may catch exceptions raised by
PostgreSQL, NATS, HTTP clients or parsers and translate them into failures.
Transport and startup retain narrowly scoped framework and fail-fast edges.

## ESM detail

The project uses ESM with NodeNext resolution. Relative source imports therefore
use `.js` suffixes, because those are the paths emitted JavaScript will load.
`import type` is erased and should be used where only a compile-time type is
needed.

## Used in

- [`result.ts`](../../../../src/shared/errors/result.ts)
- [`failure.ts`](../../../../src/shared/errors/failure.ts)
- [`example.spec.ts`](../../../../src/shared/errors/example.spec.ts)
