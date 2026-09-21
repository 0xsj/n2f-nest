# Typed failure values still need runtime boundaries

TypeScript can make the intended failure paths precise, but it cannot prevent a
JavaScript caller from throwing an arbitrary value or mutating an object alias.

## Origin

Design review while porting the previous shared errors package into the fresh
Nest backend. The goal was to preserve its semantics without pretending that a
TypeScript type is a runtime validator.

## What and why

Expected refusals use `Result<T, E>` so application code can handle them as
ordinary outcomes. A caught value uses a separate `unknown` path because
JavaScript permits throwing `null`, `undefined`, strings, numbers and hostile
objects as well as `Error` instances.

Runtime recognition uses module-private `WeakMap`s. An object that merely looks
like `{ kind: 'conflict', message: '...' }` is not automatically trusted. This
prevents deserialized data, foreign objects and accidental lookalikes from
being treated as an already-classified failure.

The public projection is explicit. Internal and unclassified values become the
generic `internal error`; a classified non-internal value exposes only its own
public message, type and fields. A cause chain never fills in missing public
metadata for the outer failure.

## Gotchas

- `readonly` is compile-time only.
- `Object.freeze` is shallow, so owned nested records must be copied and frozen
  separately.
- `unknown` is intentionally inconvenient: it prevents unsafe property access
  at the exception edge.
- `AppError` is a carrier, not a transport response. A future Nest filter must
  define HTTP or message-bus mapping separately.
- This trust model is an in-process construction boundary, not a security
  boundary against code already running in the process.

## Used in

- [`failure.ts`](../../../../../src/shared/errors/failure.ts)
- [`errors.spec.ts`](../../../../../src/shared/errors/errors.spec.ts)
