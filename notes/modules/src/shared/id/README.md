# ID module notes

The ID package separates immutable UUID values from generation effects. Parsing
validates unknown input; UUIDv7 generation consumes only wall time and entropy;
`Sequence` provides finite deterministic fixtures for tests.

- [Language walkthrough](language-walkthrough.md): brands, canonical strings,
  bit fields and failure atomicity.
- [First slice](first-slice.md): scope, ownership and why domain-specific IDs
  remain outside this package.

The executable behavior lives in [`src/shared/id/`](../../../../../src/shared/id/).
