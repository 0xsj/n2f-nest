# Document domain layer

The `Document` aggregate owns an organization reference, a normalized name, an
optional opaque `storageKey`, and an active/archived lifecycle. It does not own
file bytes, object-store calls, parsing, processing or queue state.

`create(...)` and `restore(...)` validate trusted state at their boundaries.
`archive(...)` returns a new aggregate and preserves the prior active value.
Dates are copied so JavaScript `Date` mutation cannot bypass a domain
transition. The state invariant requires archived documents to have an
`archivedAt` value and active documents not to have one.
