# TypeScript clocks: copy Dates and keep elapsed units explicit

`Date` is mutable, and wall time can be corrected. Elapsed time has a different
meaning, so the implementation stores them separately instead of deriving one
from the other.

## Date ownership

The fake stores a primitive millisecond number and constructs a fresh `Date` for
each read. Setters extract the number immediately. This matters because
`readonly` would protect only a reference, not the `Date` object behind it.

```ts
now(): Date {
  return new Date(this.#wall);
}
```

The tests mutate both the input Date and a returned Date to prove neither can
change the fake's state.

## Private fields and bigint

`#wall` and `#elapsed` are JavaScript private fields with runtime enforcement.
The `n` suffix creates a bigint. Production elapsed readings subtract two
`hrtime.bigint()` values; fake advances convert milliseconds with:

```ts
BigInt(milliseconds) * 1000000n
```

Numbers and bigints cannot be mixed in arithmetic without an explicit
conversion, which makes the unit boundary visible.

## Atomic validation

The fake accepts whole nonnegative milliseconds because that matches Date's wall
precision. `Number.isSafeInteger` rejects fractions, `NaN`, infinity and unsafe
numbers before bigint conversion. The candidate wall value is checked against
Date's representable range before either field is updated.

## Gotchas

Wall time may move backward. Monotonic elapsed time does not promise calendar
meaning or a shared origin across processes. Neither implementation sleeps or
advances automatically.

## Used in

- [`clock.ts`](../../../../../src/shared/clock/clock.ts)
- [`clock.spec.ts`](../../../../../src/shared/clock/clock.spec.ts)
