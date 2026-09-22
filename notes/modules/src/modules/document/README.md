# Document module notes

The application layer returns `DocumentApplicationFailure`. Its union combines
the closed `DocumentFailure` domain contract with application policy failures
and normalized dependency failures. The normalization boundary retains the
source adapter type as private diagnostic cause/details while exposing only a
Document-owned public type. This is the seam that allows a PostgreSQL, object
store or remote adapter to be swapped without changing Document use cases.

## Boundary

Document is the first concrete generic domain in the N2F template. It models an
organization-owned record that may point at an external artifact. It does not
assume that every application stores files, parses content, or treats a
document as its primary business object.

Document owns:

- document identity and organization ownership reference
- normalized display name
- optional opaque storage reference
- active/processing/processed/processing-failed/archived lifecycle and timestamps

The domain publishes its event vocabulary from `domain/events.ts`. Application
commands add envelope IDs, provenance and persistence handoff, but they do not
invent event names locally. Domain failures are represented by the closed
`DocumentFailure` discriminated union.

Document does not own:

- authentication or organization membership
- file bytes or object-store operations
- parsing, indexing or content extraction
- background execution and retries
- audit persistence

## Domain techniques

`Document` is an immutable aggregate. `create(...)` establishes a new active
document, `restore(...)` validates persisted state, and `archive(...)` returns
an evolved value without mutating the original. The aggregate validates its
own name, storage-reference and timestamp invariants; HTTP validation is only
an input-shape guard and PostgreSQL checks are a final persistence defense.

The aggregate is intentionally small: `storageKey` is an opaque reference and
processing is a lifecycle transition, not a parser or worker concern. A future
Document Version aggregate should be introduced only when version invariants
are real; it should not be folded into this object merely because a database
table grows.

The storage key is deliberately opaque. The domain does not interpret a path,
bucket, provider or URL. That keeps object storage replaceable and prevents
infrastructure vocabulary from becoming document language.

## Application coordination

`CreateDocument`, `ListDocuments`, `GetDocument` and `ArchiveDocument` use
explicit ports. The commands do not import Organization repositories or Audit.
They ask an `OrganizationAccessReader` capability for the current actor's
membership, then use a Document reader/writer boundary.

The first policy allows any active organization member to create and read
documents. Only owners and admins can archive or request processing because the
baseline has not introduced a document-specific owner. This is an application
policy, while the aggregate only enforces its own lifecycle.

Each state-changing command creates a versioned event with the shared
`Envelope` and `WorkContext`. The writer commits state and outbox/event handoff
together. Audit observes document facts without becoming a command dependency.
Processing transitions are exposed as application commands for the workflow
composition boundary; Document does not know that Jobs exists.

## Infrastructure and transport

The in-memory reader/writer is the default local adapter. The PostgreSQL
adapter persists metadata and enqueues the same events; it never exposes
database rows as trusted domain objects and always re-enters through
`Document.restore(...)`. The storage key is metadata only, so a future
object-store adapter can be added without changing the aggregate.

The HTTP controller translates organization-scoped bearer requests into
application commands and queries. It maps domain dates to ISO strings and does
not decide authorization or lifecycle rules.

## Shared package review

No new shared package was needed. The slice reuses the existing ID, clock,
errors, provenance, event envelope, PostgreSQL transaction and HTTP problem
capabilities. Pagination remains available as a shared capability, but the
first list contract is intentionally unpaginated until the product needs a
cursor contract. A document-specific storage reference, metadata value object,
or job contract must remain in its owning module unless another domain proves
the concept is genuinely shared.

## Verification

Domain tests cover normalization, optional storage metadata, invalid input,
immutable archival and duplicate archival rejection. The organization runtime
integration covers create, list, get, archive and Audit projection through the
Nest HTTP composition. Adapter contract tests cover both in-memory and
PostgreSQL-shaped persistence, including state-before-event ordering,
provenance rejection, rehydration and rollback on publication failure.

## Cross-domain decision

Document processing is a Document lifecycle concern, while execution remains a
Jobs concern. The `DocumentProcessingModule` workflow composes them outside
both domains. It asks Document to enter `processing`, submits a generic Job
with an opaque `{ type: "document", id }` subject, and maps Job completion,
failure and retry facts back to Document transitions.

The workflow is also the HTTP boundary for processing requests. It performs
the owner/admin policy check through Organization, then uses exported module
application commands. It does not reach into either module's repositories or
domain objects.

## Next decisions

- Should documents be visible to all organization members or have explicit
  per-document access?
- Is `storageKey` enough, or does the domain need content type, size, checksum
  or version metadata?
- Should archive be reversible, or is it a terminal state?
