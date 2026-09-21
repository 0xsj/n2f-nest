# Validation module notes

Validation owns strict reusable scalar checks and bounded field reports. It
does not own domain invariants, Nest pipes or a schema framework.

- Text length counts Unicode code points and rejects lone UTF-16 surrogates.
- Decimal input is an ASCII non-negative integer string with no leading zeroes.
- `Report` preserves first field issues, caps output at 32 fields and marks
  truncation instead of silently pretending the report is complete.
- Pagination builds on the same scalar rules but owns its cursor scope and
  bounded page window.

See [`src/shared/validation/`](../../../../../src/shared/validation/) and the
[pagination notes](../pagination/README.md).
