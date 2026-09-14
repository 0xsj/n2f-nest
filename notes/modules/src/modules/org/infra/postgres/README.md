# Organization PostgreSQL persistence

This adapter is the concrete implementation of the org-owned
`OrganizationStore` and `InvitationStore` ports. Migration 6 creates separate
organization and membership tables; migration 7 adds the membership uniqueness
key and invitation lifecycle table. Memberships reference organizations, but
intentionally do not foreign-key identity principals: org stores a principal
reference and root owns cross-domain eligibility policy.

`createOrganization` restores both snapshots before writing and inserts the
organization plus initial owner membership inside one database transaction. A
duplicate primary key or any partial-write condition rolls the transaction back
and maps the duplicate outcome to `org.organization_exists`. Invitation creation
locks actor membership; acceptance locks the invitation and atomically inserts
the member plus marks the invitation accepted; role changes lock actor and
target rows before updating. The adapter does not authenticate or decide HTTP.

The integration spec is skipped unless `N2F_TEST_DATABASE_URL` is set. The
disposable PostgreSQL proof passed; see [the evidence](org-store-verification-evidence.json).
The root-composed authenticated membership workflow passed its live PostgreSQL
proof in all three builds; ownership transfer, removal and suspension remain
future policy work.
