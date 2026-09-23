import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type {
  OrganizationMembershipView,
  OrganizationReader,
} from '../../app/index.js';
import { Membership, Organization } from '../../domain/index.js';

type OrganizationMembershipRow = {
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  organization_status: string;
  organization_created_at: Date;
  organization_updated_at: Date;
  organization_version: number;
  membership_id: string;
  membership_identity_id: string;
  membership_role: string;
  membership_status: string;
  membership_created_at: Date;
  membership_updated_at: Date;
  membership_revoked_at: Date | null;
  membership_version: number;
};

function storedId(value: unknown): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('internal', 'stored organization ID is invalid', {
        type: 'organization.persistence_invalid',
      }),
    );
  }
  return parse(value);
}

function viewFrom(row: OrganizationMembershipRow): Result<OrganizationMembershipView, Failure> {
  const organizationId = storedId(row.organization_id);
  if (!organizationId.ok) return organizationId;
  const membershipId = storedId(row.membership_id);
  if (!membershipId.ok) return membershipId;
  const identityId = storedId(row.membership_identity_id);
  if (!identityId.ok) return identityId;

  const organization = Organization.restore({
    id: organizationId.value,
    name: row.organization_name,
    slug: row.organization_slug,
    status: row.organization_status as Organization['status'],
    createdAt: row.organization_created_at,
    updatedAt: row.organization_updated_at,
    version: row.organization_version,
  });
  if (!organization.ok) return organization;

  const membership = Membership.restore({
    id: membershipId.value,
    organizationId: organizationId.value,
    identityId: identityId.value,
    role: row.membership_role as Membership['role'],
    status: row.membership_status as Membership['status'],
    createdAt: row.membership_created_at,
    updatedAt: row.membership_updated_at,
    revokedAt: row.membership_revoked_at,
    version: row.membership_version,
  });
  if (!membership.ok) return membership;

  return ok({ organization: organization.value, membership: membership.value });
}

export class PostgresOrganizationReader implements OrganizationReader {
  constructor(private readonly database: TransactionDatabase) {}

  listForIdentity(
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<readonly OrganizationMembershipView[], Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<OrganizationMembershipRow>(
          `SELECT
             o.id AS organization_id,
             o.name AS organization_name,
             o.slug AS organization_slug,
             o.status AS organization_status,
             o.created_at AS organization_created_at,
             o.updated_at AS organization_updated_at,
             o.version AS organization_version,
             m.id AS membership_id,
             m.identity_id AS membership_identity_id,
             m.role AS membership_role,
             m.status AS membership_status,
             m.created_at AS membership_created_at,
             m.updated_at AS membership_updated_at,
             m.revoked_at AS membership_revoked_at,
             m.version AS membership_version
           FROM public.n2f_organization_memberships m
           JOIN public.n2f_organization_organizations o
             ON o.id=m.organization_id
          WHERE m.identity_id=$1::uuid
            AND m.status='active'
            AND o.status<>'archived'
          ORDER BY o.created_at,o.id`,
          [identityId],
        );
        const views: OrganizationMembershipView[] = [];
        for (const row of result.rows) {
          const view = viewFrom(row);
          if (!view.ok) return view;
          views.push(view.value);
        }
        return ok(views);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
