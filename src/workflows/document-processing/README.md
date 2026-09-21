# Document processing workflow

This is an application-level process manager, not a domain. It is deliberately
outside `modules/document` and `modules/jobs` so neither domain imports or
coordinates the other.

The workflow owns the cross-domain sequence:

1. An authenticated owner or admin requests document processing.
2. The workflow asks Document to enter `processing`.
3. The workflow submits a generic Jobs record with the opaque subject
   `{ type: "document", id }`.
4. Job lifecycle events are consumed by the workflow.
5. The workflow asks Document to become `processed` or `processing_failed`.

The subject is owned by Jobs as a generic reference. The workflow is the only
place that interprets `type: "document"`. This keeps the Job aggregate free of
Document imports and keeps Document free of Job imports.

The workflow uses application commands exposed by each module. It does not
reach into repositories or domain objects, and it creates child provenance
work for every cross-domain step. The event subscription treats expected
redeliveries as no-ops through the Document commands and deduplicates job
creation by organization, kind, and subject.

The in-process bus is a development adapter. With PostgreSQL and NATS enabled,
the same events travel through the outbox and JetStream seam; no workflow code
changes.
