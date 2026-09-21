# Errors module notes

The errors package is deliberately a framework-free leaf. It gives domain and
application code a shared vocabulary without making those layers depend on
Nest, HTTP, a database or a logger.

| Note | Purpose |
| --- | --- |
| [Language walkthrough](language-walkthrough.md) | Reading order and one failure from construction to boundary |
| [First slice](first-slice.md) | What was carried into the fresh backend and why |
| [TypeScript adaptation](typescript-adaptation.md) | Runtime boundaries that static types cannot provide |

The executable behavior lives beside the implementation in
[`src/shared/errors/`](../../../../../src/shared/errors/). The tests are the
initial specification for this slice; this directory explains the intent behind
them.

`Failure` remains useful as the open boundary vocabulary for adapters.
`TypedFailure` and `typedFailure` add a required literal `type` for closed
domain or application unions, so a consumer can use exhaustive matching
without making every external dependency part of one global error enum.

The `failure(...)` helper also has a TypeScript overload: when its options
include a `type`, the returned value is a `TypedFailure`; when no type is
provided, it remains the open `Failure` form. This preserves the concise
construction style at application policy branches while keeping the compiler
honest about which failures can be exhaustively handled. Runtime provenance
and public projection still come from the same frozen constructor.

Related reusable notes:

- [Literal types and generic helpers](../../../../language/typescript-literals-generics-and-distributed-unions.md)
- [Runtime ownership and provenance](../../../../language/javascript-freezing-copying-and-weakmap-provenance.md)
- [Results and exception edges](../../../../language/typescript-results-unknown-and-exception-edges.md)
- [Specification tests](../../../../techniques/specification-tests-and-targeted-mutations.md)
