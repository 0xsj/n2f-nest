# TypeScript provenance: branded values and immutable transitions

Provenance combines several TypeScript techniques because a plain object is too
easy to confuse with a trusted value and a mutable snapshot is too easy to leak
back into an existing execution.

## Brands and private construction

Operations and IDs use branded string types. Actors, references, attributions,
incoming results, work contexts and scopes use module-private `WeakSet`s or
tokens to recognize values constructed through their factories.

The brand is compile-time guidance, not security. The `WeakSet` is an in-process
construction boundary, not authentication. A deserialized message still needs
an adapter-owned decoder and producer policy.

## Work versus scope

`WorkContext` is the logical unit: work ID, correlation, operation, attribution,
origin, depth and causation. It has no execution timestamp, executor or attempt.
`Scope` is one execution: a fresh scope ID, start time, executor, attempt and
optional previous attempt around a WorkContext.

This is why retry preserves work and depth but creates a new scope, while child
creates a new logical work and increments depth. `prepare` creates only a
WorkContext and consumes neither clock nor ID.

## Ownership at boundaries

```ts
const snapshot = scope.snapshot();
snapshot.startedAt.setTime(0);
snapshot.work.depth = 99;
```

Those mutations affect only the returned copy. The Scope stores a primitive
millisecond value and reconstructs Dates; nested replay data and link values are
copied. `Object.freeze` protects owned records, but Date copying is still needed
because freezing a Date does not stop `setTime()`.

## Transition checks

Factories validate pure inputs before reading the clock or requesting an ID.
After dependencies succeed, a generated ID is checked for canonical validity and
known local collisions. Failed generator Results are returned unchanged so their
classification and diagnostic cause remain available.

## Gotchas

- Incoming correlation is not authentication or authorization.
- A missing origin/depth is not equivalent to local origin/depth zero.
- Wall time can move backward; causal references are not inferred from timestamps.
- A retry attempt number is owner-supplied and concurrent retries may share an
  ordinal while retaining distinct scope IDs.
- Link order does not identify a primary cause.

## Used in

- [`actor.ts`](../../../../../src/shared/provenance/actor.ts)
- [`work.ts`](../../../../../src/shared/provenance/work.ts)
- [`scope.ts`](../../../../../src/shared/provenance/scope.ts)
- [`factory.ts`](../../../../../src/shared/provenance/factory.ts)
