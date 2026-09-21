# Document application layer

Application failures are closed in `failures.ts`. Domain failures pass through
unchanged; open port failures are normalized to a Document dependency failure
with the operation and original public type retained in diagnostics. This
keeps infrastructure replaceable without leaking adapter vocabulary through
the HTTP or workflow boundary.

The first application slice exposes `CreateDocument`, `ListDocuments`,
`GetDocument` and `ArchiveDocument`. Commands and queries receive a session
credential and organization ID, then use the `OrganizationAccessReader` port
instead of importing organization repositories.

Creation is available to any active organization member. Archival is restricted
to owners and admins because the baseline Document model does not yet have a
separate document-owner concept. Both state changes commit a versioned event
through the `DocumentWriter` port.
