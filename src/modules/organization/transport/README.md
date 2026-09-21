# Organization transport layer

The first delivery adapter is `POST /organizations`. It validates the
transport shape, extracts the bearer credential, opens request provenance and
delegates to `CreateOrganization`. Transport does not decide organization
rules or access the organization store.

Role administration is exposed as
`PATCH /organizations/:organizationId/memberships/:membershipId/role` with a
single `role` field. The route delegates authorization and state transition to
`ChangeMembershipRole`; it does not decide who is an owner.

Adding an existing active Identity uses
`POST /organizations/:organizationId/memberships` with `identityId` and
`role`. Invitations are not represented as active memberships yet.

Creating a pending invitation uses
`POST /organizations/:organizationId/invitations` with `identityId` and
`role`. The route only translates HTTP input and opens provenance; owner
authorization, active-Identity checks, expiry and duplicate handling belong to
`InviteIdentity`.

The invited Identity accepts through
`POST /organizations/:organizationId/invitations/:invitationId/accept`.
Authentication and invitation ownership are checked by `AcceptInvitation`; the
transport does not create the resulting Membership directly.

Owners cancel pending invitations through
`DELETE /organizations/:organizationId/invitations/:invitationId`. Accepted
or already revoked invitations are rejected by the domain transition.
