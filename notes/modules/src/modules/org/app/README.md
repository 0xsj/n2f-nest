# Organization membership workflows

`CreateOrganization` is the first org use case. It consumes four small ports:
clock, ID source, org-owned principal eligibility, and an organization store.
The store receives the organization and initial owner membership snapshots in a
single call, leaving transaction ownership to the adapter.

`InviteMember` adds a seven-day invitation workflow. It checks the target
principal through the same eligibility seam and leaves actor authorization and
the pending-invite uniqueness decision to the organization store. `AcceptInvitation`
derives the invitee from the authenticated composition-root input and asks the
store to accept and create membership atomically. `ChangeMembershipRole` keeps
the policy explicit: owner→admin/member and admin→member are allowed; self and
owner-target changes are not.

The important seam is that root can translate identity's authenticated/active
principal capability into `PrincipalEligibility` without making org import
identity. The operation treats an ineligible owner as
`Forbidden/org.principal_ineligible`; capability failures pass through. It
checks eligibility before allocating IDs or invoking the store. A principal ID
in the request is therefore never treated as authentication by this operation.

The current eligibility call is a separate capability check. It does not promise
immunity to a concurrent identity suspension between that check and the org
store transaction. A stronger guarantee must be supplied by a coordinated root
adapter; it cannot be inferred from the port name.

Verified with `pnpm exec vitest run src/modules/org/domain/org.spec.ts
src/modules/org/app/app.spec.ts`, the full Vitest suite and the live
root-composed organization HTTP flow passed under Node 24. The PostgreSQL
adapter supplies the store port; the transport is documented separately in the
[HTTP note](../transport/http/README.md).
