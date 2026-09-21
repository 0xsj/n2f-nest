# Error values belong in the core; exceptions belong at boundaries

**Status:** Established

The domain and application layers use explicit failure values, while adapters
own the translation between external exceptions and the shared `Result` type.

## Origin

The project uses a Rust-, Go- and Scala-inspired error model in TypeScript. A
review of the repository showed that module `domain/` and `app/` code already
contained no `throw` statements or `catch` clauses, but that convention was
not yet executable or documented as an architecture rule.

## What and why

Expected business outcomes are part of a use case's contract. Invalid input,
missing records, authorization refusal, conflicts and other expected outcomes
therefore return `Result<T, Failure>` values and are composed explicitly.

The rule applies to every module and workflow `domain/` and `app/` directory:

- no `throw` statements;
- no `catch` clauses;
- no exception-based control flow for expected outcomes;
- ports return values or `Result` values so application code does not need to
  know which adapter raised an exception.

This is deliberately not a claim that the entire JavaScript process can never
throw. Infrastructure libraries may reject or throw. PostgreSQL, NATS, HTTP
clients, parsers and framework APIs are boundary concerns, so infrastructure
adapters catch and translate those failures. HTTP transport may translate a
failure into a Nest response exception, and process startup may fail fast when
configuration makes the application unsafe to run.

## Language correspondence

- Go returns an `error` value and reserves `panic` for unrecoverable states.
- Rust returns `Result<T, E>` and propagates it with `?`; `panic!` remains an
  exceptional escape hatch.
- Scala commonly models expected failure with `Either`, `Try` or an effect
  type, while exceptions remain possible at integration edges.
- This project uses the shared TypeScript `Result` and `Failure` types for the
  same core-layer purpose.

## Enforcement

`scripts/check-error-boundaries.ts` parses TypeScript with the compiler API and
checks production files under module/workflow `domain/` and `app/` directories.
It excludes test files and reports actual `CatchClause` and `ThrowStatement`
syntax nodes, rather than relying on text matching.

Run it directly with:

```bash
bun run check:architecture
```

It is also part of `bun run lint` and therefore part of the normal repository
quality gate.

## Gotchas

- A `catch` at an adapter boundary is not a violation; allowing an external
  exception to leak into application code is the violation.
- A programmer-error guard in shared code may still throw. Shared code must be
  reviewed by ownership and boundary, not treated as domain behavior merely
  because a domain imports it.
- The AST check enforces direct syntax, not every possible runtime throw from a
  dependency. Boundary adapters remain responsible for translating those
  dependencies.
- Tests may use assertions and thrown fixtures; test files are intentionally
  outside this production-layer rule.

## Used in

- [`scripts/check-error-boundaries.ts`](../../scripts/check-error-boundaries.ts)
- [`src/shared/errors/result.ts`](../../src/shared/errors/result.ts)
- module `domain/` and `app/` directories under [`src/modules`](../../src/modules)
- workflow application code under [`src/workflows`](../../src/workflows)

## Related

- [Results and exception edges](../language/typescript-results-unknown-and-exception-edges.md)
- [Notes index](../README.md)
