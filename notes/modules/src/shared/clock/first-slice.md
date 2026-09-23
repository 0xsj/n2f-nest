# The first clock slice: explicit time without global state

The clock establishes the time boundary needed by IDs, retries and provenance
without letting those consumers reach directly into the operating system.

## Origin

Ported from the predecessor product's backend on 2026-09-18 after the errors leaf.
The behavior was retained, while the new backend adds explicit `WallClock`,
`MonotonicClock` and combined `Clock` interfaces for narrower dependencies.

## What it does

- `SystemClock.now()` samples wall time as a copied `Date`.
- `SystemClock.elapsed()` uses monotonic nanoseconds from a private origin.
- `FakeClock` starts stable, advances only when instructed and supports wall
  correction without resetting elapsed time.
- Invalid Dates and advances fail before changing state.
- Date inputs and outputs cannot mutate the fake's internal state.

## Why this comes before IDs and provenance

Time-ordered IDs need a wall timestamp and deterministic tests need a clock they
can control. Provenance needs explicit execution start times and must distinguish
wall observations from elapsed durations. Building those concepts first prevents
each later package from inventing its own time abstraction.

## Limits

Elapsed readings are comparable only within the same clock instance. They are
not persisted, cross-process values, calendar utilities or a scheduling system.
The fake is synchronous within one JavaScript isolate; it is not a worker-shared
mutex or timer replacement.

## Used in

- [`clock.ts`](../../../../../src/shared/clock/clock.ts)
- [`clock.spec.ts`](../../../../../src/shared/clock/clock.spec.ts)
