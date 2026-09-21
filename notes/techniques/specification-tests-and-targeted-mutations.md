# Specification tests should make tempting wrong implementations fail

A useful test does more than confirm the current implementation: it distinguishes
the intended behavior from a simple but wrong alternative.

## Origin

This technique carried forward from the previous errors package. The fresh slice
uses executable Vitest examples as its initial behavioral specification without
requiring a separate `CONTRACT.md`.

## Apply it to errors

- Use an untouched field key to prove metadata is merged rather than replaced.
- Use distinct cause objects to prove enrichment preserves or replaces the
  intended source only.
- Include private-looking values to prove public projection is deliberate.
- Use `null`, `undefined`, primitives and a hostile Proxy to prove normalization
  does not assume every thrown value is an `Error`.
- Test success mapping with a mapper that throws if called unexpectedly.
- Test both aggregate orderings so the first branch cannot silently become the
  summary classification.

The expected records are written explicitly. Reusing the implementation's own
merge helper in the expectation would allow the same defect on both sides.

## Type checks are a separate layer

`expectTypeOf` documents literal preservation, but a normal runtime test does
not prove every type relationship. Build/type-checking and runtime assertions
answer different questions and should both remain green.

## Limits

These tests are evidence, not proof of all possible behavior. If mutation
testing is introduced later, record which deliberately selected faults were
caught and restore the baseline before continuing. Do not treat a small mutation
sample as a completeness claim.

## Used in

- [`errors.spec.ts`](../../../../src/shared/errors/errors.spec.ts)
- [`example.spec.ts`](../../../../src/shared/errors/example.spec.ts)
