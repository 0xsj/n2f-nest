# Organization domain: organization, membership and invitation leaves

The organization domain establishes validated values and local lifecycle
invariants. It does not authenticate a principal, inspect identity storage,
choose HTTP status codes, or own a database transaction. Application operations
compose eligibility and authorization with one organization transaction.

| Scenario | Observable guarantee |
| --- | --- |
| O01 | An organization has a nonzero validated ID, a preserved name, and a bounded nonnegative creation time. |
| O02 | Names contain 1..100 Unicode scalars, reject ASCII-whitespace-only and C0/DEL control input, and are not trimmed, normalized or case-folded. |
| O03 | A membership has a nonzero membership ID, organization ID and principal ID, a closed role (`owner`, `admin`, `member`), and a bounded nonnegative creation time. |
| O04 | Initial-owner construction always produces the `owner` role; supplying a principal ID alone never establishes eligibility or authority. |
| O05 | Restore validates and preserves history; it never silently regenerates IDs or resets timestamps. |
| O06 | Returned snapshots own their mutable data. Mutating a caller-owned snapshot or input string cannot change a stored value. |
| O07 | Invalid organization data is classified as `Invalid / org.organization_invalid`; invalid membership data as `Invalid / org.membership_invalid`; an invalid role, where the host language can represent one, is `Invalid / org.role_invalid`. |
| O08 | An invitation has nonzero organization, inviter, invitee and invitation IDs; its inviter differs from its invitee; its role is `admin` or `member`; and its expiry is after creation within the supported time range. |
| O09 | Pending invitations have no resolution time; accepted or revoked invitations have one. Restore preserves the recorded state and does not regenerate identity or timestamps. |
| O10 | Only pending invitations can transition. Accept requires a timestamp within the invitation window and produces an accepted snapshot; revoke produces a revoked snapshot. |

The organization and its initial owner membership are separate values in this
leaf. A later `CreateOrganization` application operation must validate the
owner through an org-owned principal-eligibility port and persist both values
inside the same organization transaction. A reference to a principal is not an
authentication proof, an active-status proof or an organization permission.

The domain intentionally does not authenticate principals, decide who may invite
or change roles, or own transaction boundaries. Those policies belong to the
application/store workflow. Membership suspension, ownership transfer, removal,
slug uniqueness, deletion, retention and cross-organization policy remain
separate decisions.
