# Organization application: organization membership workflows

The org application composes domain leaves and org-owned ports. It does not
authenticate HTTP, import identity internals, choose status codes, or expose a
database transaction object. Root supplies eligibility and session-derived
principal references.

| Scenario | Observable guarantee |
| --- | --- |
| O08 | `CreateOrganization` receives an organization name and owner principal reference; the operation itself is not an authentication boundary. |
| O09 | The owner is checked through an org-owned principal-eligibility port. An ineligible owner returns `Forbidden / org.principal_ineligible`; a port failure passes through. |
| O10 | After eligibility, the operation obtains time and two IDs, constructs the organization and explicit owner membership through the domain constructors, and maps clock/ID failures to `Unavailable / org.create_dependency_failed`. |
| O11 | The organization store receives both validated snapshots through one `CreateOrganization` call. The store owns the organization transaction boundary. |
| O12 | A successful store result returns both snapshots. An expected duplicate outcome returns `Conflict / org.organization_exists`; dependency failures pass through. |
| O13 | A principal ID is a reference, not authentication, active status or authority. Stronger concurrent-suspension guarantees require a coordinated eligibility/store adapter and are not implied by a separate lookup. |
| O14 | `InviteMember` checks the invitee through the org-owned active-eligibility port, then permits an owner to invite `admin` or `member`, while an admin may invite only `member`; the store owns the transaction and final membership lock. |
| O15 | Pending duplicate invitations map to `Conflict / org.invitation_exists`; an existing member maps to `Conflict / org.member_exists`; store authorization maps to `Forbidden / org.membership_forbidden`. |
| O16 | `AcceptInvitation` receives the invitee principal from authenticated session admission, and the store atomically locks the invitation, verifies target/status/expiry, creates membership and marks the invitation accepted. Replay, expiry, missing target and member conflicts remain distinct. |
| O17 | `ChangeMembershipRole` allows an owner to assign `admin` or `member` and an admin to assign `member`; self changes and owner-target changes are rejected, and the store locks actor/target membership in one transaction. |
| O18 | Invitation lifetime is seven days. These operations do not send mail, authenticate sessions, transfer ownership, remove members or suspend memberships; those are separate composition decisions. |

The create operation still creates one organization and one owner membership.
Membership workflow policy is explicit in the invitation and role operations;
transport mappings and authentication remain outside this package, while mail,
ownership transfer, removal and suspension remain future policy slices.
