# Organization PostgreSQL store

**Stage:** concrete persistence for organization membership workflows.
This adapter implements the org-owned `OrganizationStore` port with the shared
PostgreSQL transaction boundary. It owns SQL and row validation; no database or
driver type crosses the org application contract.

| Scenario | Observable guarantee |
| --- | --- |
| S01 | Migration 6 creates organization and membership tables with domain bounds, closed roles, a membership-to-organization foreign key, and no foreign key into identity. |
| S02 | `CreateOrganization` restores both incoming snapshots before writing and rejects a mismatched organization/owner pair as `Invalid / org.store_invalid_record`. |
| S03 | Organization and initial owner membership are inserted in one transaction. A duplicate ID rolls the whole transaction back and returns the expected `AlreadyExists` value. |
| S04 | Database failures and commit uncertainty preserve the shared PostgreSQL classification; they are never reported as duplicate or success. |
| S05 | This adapter does not authenticate or check principal eligibility. The application port does that before the store call; the principal ID remains a reference. |
| S06 | Migration 7 adds a unique organization/principal membership key and an invitation table with closed roles/statuses, a seven-day-capable expiry range, resolved-state checks, a pending-target uniqueness index and invitee/status lookup. |
| S07 | Invitation creation locks the actor membership, checks owner/admin policy and existing membership, and returns a distinct duplicate-pending outcome without exposing identity tables. |
| S08 | Invitation acceptance locks the invitation, verifies the authenticated invitee and pending/expiry state, then inserts membership and marks the invitation accepted in one transaction; the membership uniqueness key makes retries safe. |
| S09 | Role changes lock actor and target membership rows, allow owner→admin/member and admin→member only, reject owner/self targets, and commit the role update atomically. |

The schema deliberately avoids a cross-module identity foreign key. Root composes
identity eligibility with org, and a future extracted org service must not depend
on identity's table name or migration. Organization-local referential integrity
is still enforced for membership organization IDs.

The schema still avoids a cross-module identity foreign key. Invitation delivery
is not an SMTP concern here: the application receives an existing eligible
principal reference. Ownership transfer, removal, suspension, slug uniqueness,
retention, outbox facts and HTTP transport remain outside this adapter.
