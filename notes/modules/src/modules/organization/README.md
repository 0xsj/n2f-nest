# Organization module

Organization use cases return `OrganizationApplicationFailure`, a union of the
Organization, Membership and Invitation domain failures plus application
policy and dependency failures. The application layer maps open Identity,
reader, writer and envelope failures at the point where it owns the operation
name. This keeps the bounded contexts independent while still making every
expected failure exhaustive for the caller.

The Organization module owns the tenant: the company, team or other
organization that operates within a product built on this backend. It is separate from Identity: Identity
answers who can authenticate, while Organization answers which operating
context that identity belongs to and what role it has there.

## First domain contract

The initial domain-only slice contains two immutable aggregates:

- `Organization`: normalized name and slug, lifecycle status, and timestamps.
- `Membership`: an Identity's relationship to an Organization, with `owner`,
  `admin` or `member` role and an active/revoked status.
- `Invitation`: a pending role offer to an existing active Identity, with
  expiry and future acceptance/revocation transitions.

Each aggregate has its own typed domain-failure union. Event names are grouped
in `domain/events.ts`, while application commands construct the shared
envelopes and coordinate multi-aggregate commits.

The creator-becomes-owner rule is intentionally an application transaction,
not a constructor side effect. The create command persists the Organization
and its owner Membership together and publishes their events from the same
outbox boundary.

This is a bounded-context transaction, not a single giant Organization
aggregate. Organization, Membership and Invitation keep independent lifecycle
invariants; commands use explicit ports when a use case must coordinate them.

## Boundary

Organization owns:

- organization identity and lifecycle
- organization naming and slug uniqueness through an application port
- memberships and organization roles
- organization-scoped authorization decisions

It does not own:

- authentication credentials or sessions
- fan profiles
- Audit storage

The domain accepts Identity IDs as references. It does not import the Identity
module or call Identity use cases. The application owns a
`CurrentActorReader` port, which is fulfilled at composition time by adapting
Identity's current-identity query.

## Deliberate omissions

The first slice does not yet decide email-based invitation discovery, billing,
multi-owner policy, organization kinds or organization settings. Those belong
to explicit product decisions and should not be smuggled into the initial
aggregate model.

## Used in

- `src/modules/organization/domain/organization.ts`
- `src/modules/organization/domain/membership.ts`
- `src/modules/organization/domain/invitation.ts`
- `src/modules/organization/app/commands/create-organization.ts`
- `src/modules/organization/app/commands/add-membership.ts`
- `src/modules/organization/app/queries/list-current-organizations.ts`
- `src/modules/organization/app/commands/change-membership-role.ts`
- `src/modules/organization/app/commands/invite-identity.ts`
- `src/modules/organization/app/commands/accept-invitation.ts`
- `src/modules/organization/app/commands/revoke-invitation.ts`
- `src/modules/organization/app/ports/current-actor-reader.ts`
- `src/modules/organization/app/ports/organization-reader.ts`
- `src/modules/organization/app/ports/organization-writer.ts`
- `src/modules/organization/app/ports/membership-reader.ts`
- `src/modules/organization/app/ports/membership-writer.ts`
- `src/modules/organization/app/ports/invitation-reader.ts`
- `src/modules/organization/app/ports/invitation-writer.ts`
- `src/modules/organization/app/ports/identity-reference-reader.ts`
- `src/modules/organization/infra/requires.ts` (tokens the composition root supplies)
- `src/integration/organization-identity.ts` (the Identity bridges)
- `src/modules/organization/infra/in-memory/reader.ts`
- `src/modules/organization/infra/in-memory/writer.ts`
- `src/modules/organization/infra/in-memory/membership-reader.ts`
- `src/modules/organization/infra/in-memory/membership-writer.ts`
- `src/modules/organization/infra/in-memory/invitation-reader.ts`
- `src/modules/organization/infra/in-memory/invitation-writer.ts`
- `src/modules/organization/infra/in-memory/invitation-acceptance-writer.ts`
- `src/modules/organization/infra/postgres/reader.ts`
- `src/modules/organization/infra/postgres/membership-reader.ts`
- `src/modules/organization/infra/postgres/membership-writer.ts`
- `src/modules/organization/infra/postgres/invitation-reader.ts`
- `src/modules/organization/infra/postgres/invitation-writer.ts`
- `src/modules/organization/infra/postgres/invitation-acceptance-writer.ts`
- `src/modules/organization/infra/postgres/writer.ts`
- `src/modules/organization/infra/postgres/migrations/0007_organization.sql`
- `src/modules/organization/infra/postgres/migrations/0008_organization_invitations.sql`
- `src/modules/organization/transport/http/organization.controller.ts`
- `src/modules/organization/organization.module.ts`

## Next slice

Complete invitations as a separate pending lifecycle: scheduled expiry and
email-based discovery/delivery remain future seams. The current increment
targets an existing active Identity by ID, uses a seven-day expiry, supports
owner revocation, and transitions into an active Membership only through
explicit acceptance. Organization suspension and Audit subject semantics still
need explicit product decisions rather than being inferred from membership
roles.

## Application command

`CreateOrganization` accepts a session credential, resolves the active actor
through `CurrentActorReader`, creates both domain objects, emits versioned
organization and membership facts, and gives them to one
`OrganizationWriter.commit` call. The writer owns the transaction and outbox
boundary. The command does not import Identity, inspect sessions, or open a
database connection.

The current HTTP composition adapter adapts Identity's exported
`GetCurrentIdentity` query to Organization's `CurrentActorReader` port. This is
an application-composition dependency, not a domain dependency: the
Organization domain only stores the Identity ID reference. The in-memory
writer provides the same commit boundary used by the future PostgreSQL writer
and publishes both events through the replaceable event bus, allowing Audit to
project them without coupling the command to Audit.

The first integration test deliberately checks the complete local path rather
than reaching into stores. It verifies that authentication is required, the
current actor crosses the module seam, the command returns both IDs, and both
Organization events reach Audit.

The PostgreSQL integration repeats the same flow against migration `0007` and
asserts the organization row, owner membership, outbox state and Audit
projection. The NATS integration runs that flow through JetStream as well, so
the application port is exercised across local, PostgreSQL and remote
event-delivery modes.

`ListCurrentOrganizations` follows the same composition seam as creation:
transport extracts the bearer token, the application resolves the actor, and
the reader rehydrates immutable Organization and Membership values. The
PostgreSQL reader uses explicit `restore(...)` factories instead of exposing
database rows as trusted application data.

`ChangeMembershipRole` introduces the first authorization policy: only an
active owner membership can change another active member's role, and the
owner membership is locked against demotion by this command. The policy is
application-level because it depends on the current actor and organization
context; `Membership.changeRole(...)` remains responsible for the immutable
domain transition and role vocabulary.

`AddMembership` uses the same owner policy and accepts only an active Identity
reference. The Organization module does not import Identity repositories; its
composition adapter calls the exported `GetIdentity` query and reduces the
result to the Organization-owned `IdentityReferenceReader` capability. The
membership writer supports both new inserts and later immutable transitions,
while retaining one event/outbox boundary.

`RevokeMembership` uses the same owner policy and turns an active non-owner
membership into a revoked membership through `Membership.revoke(...)`. The
owner membership is locked against revocation by this command, and the active
organization list hides revoked memberships. Revocation emits a separate
versioned fact so Audit can retain the history without making Audit a command
dependency.

`InviteIdentity` uses the same owner policy but creates a separate pending
Invitation. It first verifies that the target Identity is active and is not
already a member, then commits the invitation and
`organization.invitation.created.v1` through one writer/outbox boundary. The
invitation aggregate owns expiry and future acceptance/revocation transitions;
the command does not create a Membership as a side effect.

`AcceptInvitation` is intentionally not composed from the ordinary invitation
and membership writers. It uses an `InvitationAcceptanceWriter` port so the
accepted Invitation, new Membership, `organization.invitation.accepted.v1`
fact and `organization.membership.added.v1` fact share one commit/outbox
boundary. The command authenticates the current actor, requires that the actor
matches the invited Identity, checks for an existing membership, and lets the
Invitation aggregate enforce expiry and pending-state rules.

The adapter contract suite exercises the same boundaries without importing
Nest composition: organization creation writes both aggregates before its two
outbox facts, provenance mismatches perform no database work, rows rehydrate
through all three domain restore factories, and in-memory invitation
acceptance rolls back as one multi-aggregate unit when event publication fails.

`RevokeInvitation` lets an owner cancel a still-pending invitation through the
same `InvitationWriter` state-plus-event boundary. Accepted invitations are
not revocable by this command, and expiry is currently evaluated when an
invitation is accepted rather than materialized by a background scheduler.
