# Document infrastructure layer

The first implementation uses an in-memory reader and writer so the domain and
application contract can be exercised without selecting a file store. The
`storageKey` is an opaque reference; the Document module does not read or write
file bytes.

The future PostgreSQL adapter will persist document metadata and enqueue the
same versioned facts. A blob/object-store adapter, if needed, will remain a
separate port rather than leaking into the domain.
