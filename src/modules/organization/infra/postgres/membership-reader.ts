import {
  err,
  failure,
  ok,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { MembershipReader } from '../../app/index.js';
import { Membership } from '../../domain/index.js';

type MembershipRow = {
  id: string;
  organization_id: string;
  identity_id: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
};

function storedId(value: unknown): Result<ID, Failure> {
  if (typeof value !== 'string') {
    return err(
      failure('internal', 'stored membership ID is invalid', {
        type: 'organization.persistence_invalid',
      }),
    );
  }
  return parse(value);
}

function membershipFrom(row: MembershipRow): Result<Membership, Failure> {
  const id = storedId(row.id);
  if (!id.ok) return id;
  const organizationId = storedId(row.organization_id);
  if (!organizationId.ok) return organizationId;
  const identityId = storedId(row.identity_id);
  if (!identityId.ok) return identityId;

  return Membership.restore({
    id: id.value,
    organizationId: organizationId.value,
    identityId: identityId.value,
    role: row.role as Membership['role'],
    status: row.status as Membership['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  });
}

export class PostgresMembershipReader implements MembershipReader {
  constructor(private readonly database: TransactionDatabase) {}

  findById(
    membershipId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>> {
    return this.read(
      `SELECT id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at
         FROM public.n2f_organization_memberships
        WHERE id=$1::uuid`,
      [membershipId],
      signal,
    );
  }

  findActiveForIdentity(
    organizationId: ID,
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>> {
    return this.read(
      `SELECT id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at
         FROM public.n2f_organization_memberships
        WHERE organization_id=$1::uuid AND identity_id=$2::uuid AND status='active'`,
      [organizationId, identityId],
      signal,
    );
  }

  findForIdentity(
    organizationId: ID,
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>> {
    return this.read(
      `SELECT id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at
         FROM public.n2f_organization_memberships
        WHERE organization_id=$1::uuid AND identity_id=$2::uuid`,
      [organizationId, identityId],
      signal,
    );
  }

  private read(
    sql: string,
    values: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<Result<Membership | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<MembershipRow>(sql, [...values]);
        const row = result.rows[0];
        return row === undefined ? ok(null) : membershipFrom(row);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
