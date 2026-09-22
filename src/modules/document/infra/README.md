# Document infrastructure layer

The module selects a complete reader/writer pair from the platform storage
capability. Memory mode keeps the domain and application contract
self-contained; PostgreSQL mode rehydrates metadata from explicit rows and
commits state plus the matching event through the shared outbox boundary. The
`storageKey` is an opaque reference; the Document module does not read or write
file bytes.

A blob/object-store adapter, if needed, will remain a separate port rather than
leaking into the domain. This keeps database selection and file storage
selection independent concerns.

Adapter contract tests cover the in-memory write/read path, rollback when event
publication fails, PostgreSQL state-before-outbox ordering, row rehydration and
safe database failure mapping.
