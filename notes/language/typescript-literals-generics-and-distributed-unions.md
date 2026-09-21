# Literal inference keeps a failure specific through helpers

The type machinery preserves the caller's known case; it does not establish
that an arbitrary runtime object is a valid failure.

## Derive the closed union

```ts
const KINDS = Object.freeze(['internal', 'invalid', 'conflict'] as const);
type Kind = (typeof KINDS)[number];
```

`as const` preserves literal entries instead of widening them to `string`.
`typeof KINDS` in a type position asks for the value's type, and `[number]`
extracts the union of its element types. The runtime array remains available to
parse external input; the `Kind` type itself does not exist at runtime.

## Preserve local cases

```ts
function failure<K extends Kind, const T extends string = string>(
  kind: K,
  message: string,
  options?: { type?: T },
): Failure<K, T>;
```

The kind and type can remain narrow at the call site, so a failure constructed
as `failure('conflict', ..., { type: 'account.email_taken' })` retains those
literals in later code. Enrichment helpers return the original generic `F`
instead of widening everything to the broad `Failure` union.

`Readonly` prevents writes through the TypeScript view, while `Record<string,
string>` describes the dictionary shape. Neither validates or freezes a runtime
object.

## Gotchas

Type assertions such as `as Failure<K, T>` are implementation promises. They are
safe here only because the factory constructs the required shape and checks the
runtime kind immediately before asserting it.

The shared `Kind` union does not replace domain-owned failure unions. A domain
still owns the cases and stable `type` identifiers that its callers need to
handle precisely.

## Used in

- [`kind.ts`](../../../../src/shared/errors/kind.ts)
- [`failure.ts`](../../../../src/shared/errors/failure.ts)
