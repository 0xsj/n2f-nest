# The first ID slice: values separate from generation effects

An ID is a value once constructed, but producing one is an effect that can fail.
Keeping those responsibilities separate makes parsing, testing and provenance
composition easier.

## Origin

Ported from the predecessor product's backend on 2026-09-18 after the errors and clock
leaves. The fresh version consumes the shared `WallClock` capability rather than
duplicating that interface locally.

## What it does

- Parses canonical UUID strings with the standard variant and emits lowercase.
- Uses a compile-time branded string so validated IDs are distinct from strings.
- Reads version and UUIDv7 Unix-millisecond fields from validated values.
- Generates UUIDv7 values with a 48-bit timestamp, version bits, counter,
  standard variant bits and cryptographic entropy.
- Preserves ordering within one generator across equal or backward wall times.
- Returns typed failures instead of committing state when entropy, time range or
  counter limits refuse a generation.
- Copies the input list for finite `Sequence` fixtures.

## Why domain IDs do not live here

The shared ID is an identifier primitive, not a user/account ID or a domain
relationship ID. Domains may wrap or name the primitive when their invariants
require it; the shared package should not collect product vocabulary.

## Limits

Ordering is guaranteed only within one generator instance. There is no global
uniqueness or cross-process ordering guarantee; storage uniqueness constraints
and domain ownership still matter. IDs are identifiers, not authorization
secrets.

## Used in

- [`value.ts`](../../../../../src/shared/id/value.ts)
- [`v7.ts`](../../../../../src/shared/id/v7.ts)
- [`sequence.ts`](../../../../../src/shared/id/sequence.ts)
- [`id.spec.ts`](../../../../../src/shared/id/id.spec.ts)
