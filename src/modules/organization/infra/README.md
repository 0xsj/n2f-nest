# Organization infrastructure layer

The process-local and PostgreSQL adapters implement the same application
ports. `InMemoryOrganizationWriter` owns the local commit boundary, while
`PostgresOrganizationWriter` uses one transaction for the organization row,
owner membership and outbox events. Organization's actor and
identity-reference ports are supplied from outside the module through
`ORGANIZATION_REQUIRES` (see `src/integration/organization-identity.ts`).
Neither adapter leaks into the Organization or Membership domain objects.

Membership role changes use separate reader and writer ports. Both in-memory
and PostgreSQL writers update the immutable membership state and enqueue the
versioned event together; the PostgreSQL adapter does not publish before its
transaction commits.

Revocation uses the same writer boundary: the application supplies the
immutable revoked state and its versioned event, while the adapter performs
the update and event handoff atomically. The active-membership reader then
omits the revoked relationship without deleting its history.

Invitation persistence has its own reader and writer ports plus migration
`0008`. The first adapter stores a pending invitation for an existing active
Identity, with a partial unique index allowing only one pending invitation per
organization and identity. It does not yet deliver email; acceptance and
revocation now use explicit application seams.

Acceptance uses a separate writer because it changes two aggregates and emits
two facts. The in-memory adapter rolls both changes back if event publication
fails; the PostgreSQL adapter updates the invitation, inserts the membership,
and enqueues both events in one transaction. This preserves the local-to-
durable seam without making the application command know either persistence
strategy.

The ordinary invitation writer supports both inserts and state updates. That
keeps revocation behind the same port as creation while preserving the
PostgreSQL outbox transaction and the in-memory rollback behavior.

The same writer also inserts a new membership when its ID is not yet present.
That keeps membership creation and role transitions behind one application
port without making the command know which persistence operation is required.

Adapter contract tests cover the organization pair, membership and invitation
rehydration, multi-event provenance checks, invitation acceptance, rollback on
event failure and safe database failure mapping.
