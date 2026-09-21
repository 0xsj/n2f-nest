# Runtime ownership needs copies, freezing and a recognition boundary

TypeScript describes a shape, while JavaScript decides which objects can change
and which values were actually constructed by this module.

## Copy before freezing

```ts
Object.freeze({ ...options.fields });
```

The spread creates a new record, so freezing it does not freeze the caller's
input. The outer failure is frozen too. Since the owned metadata values are
strings, this shallow copy-and-freeze policy is sufficient for the current
surface; arbitrary causes remain opaque references.

For enrichment, spread order is the merge policy:

```ts
Object.freeze({ ...value.fields, ...fields });
```

Existing unrelated keys survive and later supplied keys replace collisions. The
public projection returns another copy so a caller can modify its view without
changing the originating failure.

## Keep diagnostics private

```ts
const diagnostics = new WeakMap<object, Diagnostic>();
```

The failure-shaped object contains only deliberate public data. The cause and
private details live in a module-private identity map. A second map recognizes
genuine `AppError` carriers without trusting a mutable public property.

Weak keys avoid requiring a cleanup registry when a failure becomes unreachable.
This is provenance by in-process identity, not cryptographic proof or a security
boundary.

## Avoid probing hostile values

`fromCaught` may receive a Proxy with throwing getters, or a primitive. The
recognition helper checks identity in the private maps without reading foreign
properties or walking a cause chain. Unknown values are retained as opaque
diagnostic causes and receive the safe internal projection.

## Gotchas

The factory is for trusted application construction, not arbitrary JSON parsing.
Object spread can execute getters on supplied options, so untrusted input should
be validated before it reaches the factory. Never serialize a `Failure` directly
as a public response; use `publicInfo`.

## Used in

- [`failure.ts`](../../../../src/shared/errors/failure.ts)
- [`errors.spec.ts`](../../../../src/shared/errors/errors.spec.ts)
