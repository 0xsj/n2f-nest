# TypeScript IDs: brands are compile-time promises

The ID brand distinguishes validated values in typed code, but runtime parsing
is what establishes that a value actually satisfies the format.

## The brand has no runtime wrapper

```ts
declare const idBrand: unique symbol;
type ID = string & { readonly [idBrand]: true };
```

The `unique symbol` marker exists only to make the intersection distinct from an
ordinary string. At runtime an ID is still a canonical string, which gives it
value equality, ordinary JSON output and useful `Map` keys.

A type assertion can bypass the brand. It is therefore not input validation or a
security boundary; `parse(unknown)` remains the runtime admission point.

## Canonical parsing

The parser checks both length and the UUID shape. The length check makes the
accepted representation exact, including rejecting trailing whitespace or a
newline. It accepts either input case but returns lowercase so equivalent values
have one representation.

`version` and `unixMillis` assume an already validated ID. They are value readers,
not alternate parsers for arbitrary input.

## UUIDv7 encoding

The UUIDv7 timestamp uses safe integer arithmetic because its 48-bit range fits
inside JavaScript's safe integer range. The counter and random suffix use small
bitwise operations. The generator consumes ten random bytes: two seed the
counter on a fresh timestamp and eight become the suffix after the variant bits
are set.

When time repeats or moves backward, the generator holds the previous timestamp
and increments its counter. State is committed only after entropy succeeds, so a
failed entropy call cannot consume a counter or timestamp transition.

## Gotchas

- `Result` requires callers to narrow `ok` before reading the value or failure.
- Entropy callbacks may throw any JavaScript value; the shared error preserves it
  privately as the cause.
- A `Sequence` copies its list but intentionally permits duplicate fixture IDs.
- JavaScript bitwise operators use 32-bit values; the timestamp is formatted
  with safe integer and hexadecimal operations instead.

## Used in

- [`value.ts`](../../../../../src/shared/id/value.ts)
- [`v7.ts`](../../../../../src/shared/id/v7.ts)
- [`id.spec.ts`](../../../../../src/shared/id/id.spec.ts)
