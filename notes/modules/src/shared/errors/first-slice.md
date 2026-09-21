# The first errors slice: a small shared boundary

The first implementation keeps errors useful across domains without making the
shared package responsible for transport policy.

## Origin

Ported from the previous Signals backend on 2026-09-18 while restarting the
Nest application from a clean scaffold. The previous implementation already
had the desired semantics, so the useful behavior was retained while its large
contract document and template-specific commentary were not copied forward.

## What it does

- `KINDS` is a closed, exhaustive vocabulary of ten stable categories.
- `Failure` carries a category, public message, optional stable `type` and
  optional public field problems.
- `details` and `cause` stay diagnostic and are not part of the public shape.
- Failure values and owned metadata are copied and frozen.
- `Result<T, E>` keeps expected refusals in the return type.
- `AppError` is only a framework-free carrier for a boundary that must throw.
- `fromCaught` treats every caught value—including `null` and `undefined`—as a
  real failure unless it is one of this module's trusted values or carriers.

## Why it is not a Nest module

No controller, filter, provider or decorator belongs here. HTTP status codes,
message envelopes, logging, retry decisions and NATS response mapping are
policies of their owning boundaries. Keeping this package free of those
concerns makes the future in-process-to-remote seam smaller.

## Verification

The tests cover the closed vocabulary, literal type preservation, safe public
projection, metadata isolation, cause retention, aggregate behavior, hostile
caught values and exception carriers. The fresh backend currently passes the
full unit suite, build and lint.

## Used in

- [`kind.ts`](../../../../../src/shared/errors/kind.ts)
- [`failure.ts`](../../../../../src/shared/errors/failure.ts)
- [`result.ts`](../../../../../src/shared/errors/result.ts)
- [`errors.spec.ts`](../../../../../src/shared/errors/errors.spec.ts)
- [`example.spec.ts`](../../../../../src/shared/errors/example.spec.ts)
