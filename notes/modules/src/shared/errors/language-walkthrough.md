# Reading the errors leaf as TypeScript and JavaScript

The important lesson is that TypeScript expresses the intended shapes while
JavaScript still decides which values are mutable, trusted and safe to expose.

## Suggested reading order

| Source | Notice |
| --- | --- |
| [`kind.ts`](../../../../../src/shared/errors/kind.ts) | `as const`, indexed access types and runtime parsing |
| [`failure.ts`](../../../../../src/shared/errors/failure.ts) | generic literals, copied metadata and private provenance |
| [`result.ts`](../../../../../src/shared/errors/result.ts) | discriminated unions, `never` and branch-only mapping |
| [`index.ts`](../../../../../src/shared/errors/index.ts) | stable runtime and type-only exports |
| [`errors.spec.ts`](../../../../../src/shared/errors/errors.spec.ts) | runtime assertions alongside compile-time assertions |

## Follow one failure

```ts
const refused = err(
  failure('conflict', 'email already registered', {
    type: 'account.email_taken',
    fields: { email: 'taken' },
    cause: new Error('PRIVATE database constraint'),
  }),
);

const contextual = mapError(refused, (error) =>
  withDetails(error, { operation: 'register' }),
);

if (!contextual.ok) {
  throw new AppError(contextual.error);
}
```

The domain can return the refusal without throwing. An outer boundary may carry
it through an exception path, then call `fromCaught` and `publicInfo` to produce
safe transport data. The private cause and operation detail remain available to
the observing boundary but are not returned as response fields.

## TypeScript and JavaScript are doing different jobs

`as const` and generic parameters preserve useful literal information during
checking. `Object.freeze`, copied records and private `WeakMap`s handle runtime
ownership. Neither half replaces the other: a readonly type does not stop a
JavaScript mutation, and a frozen object does not prove that a foreign object is
a genuine failure from this module.

With the package configured as ESM and using NodeNext resolution, relative
imports intentionally use the emitted `.js` suffix even though the source is
`.ts`.

## Used in

This note follows the implementation in `src/shared/errors/` and the behavior
assertions in its Vitest specifications.
