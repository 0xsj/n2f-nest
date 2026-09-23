import { err, ok, type Failure, type Result } from '../../../../shared/errors/index.js';
import { parse, type ID } from '../../../../shared/id/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { InvitationReader } from '../../app/index.js';
import { Invitation } from '../../domain/index.js';

type InvitationRow = {
  id: string;
  organization_id: string;
  identity_id: string;
  role: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  version: number;
};

function id(value: string): Result<ID, Failure> {
  const parsed = parse(value);
  return parsed.ok
    ? parsed
    : err({ kind: 'internal', message: 'stored invitation ID is invalid', type: 'organization.persistence_invalid' });
}

function restore(row: InvitationRow): Result<Invitation, Failure> {
  const invitationId = id(row.id);
  if (!invitationId.ok) return invitationId;
  const organizationId = id(row.organization_id);
  if (!organizationId.ok) return organizationId;
  const identityId = id(row.identity_id);
  if (!identityId.ok) return identityId;
  return Invitation.restore({
    id: invitationId.value,
    organizationId: organizationId.value,
    identityId: identityId.value,
    role: row.role as Invitation['role'],
    status: row.status as Invitation['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    version: row.version,
  });
}

export class PostgresInvitationReader implements InvitationReader {
  constructor(private readonly database: TransactionDatabase) {}

  findById(
    invitationId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Invitation | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<InvitationRow>(
          `SELECT id,organization_id,identity_id,role,status,created_at,updated_at,expires_at,accepted_at,revoked_at,version
             FROM public.n2f_organization_invitations
            WHERE id=$1::uuid`,
          [invitationId],
        );
        const row = result.rows[0];
        return row === undefined ? ok(null) : restore(row);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }

  findPendingForIdentity(
    organizationId: ID,
    identityId: ID,
    signal?: AbortSignal,
  ): Promise<Result<Invitation | null, Failure>> {
    return this.database.transaction(async (transaction) => {
      try {
        const result = await transaction.query<InvitationRow>(
          `SELECT id,organization_id,identity_id,role,status,created_at,updated_at,expires_at,accepted_at,revoked_at,version
             FROM public.n2f_organization_invitations
            WHERE organization_id=$1::uuid AND identity_id=$2::uuid AND status='pending'
            ORDER BY created_at DESC LIMIT 1`,
          [organizationId, identityId],
        );
        const row = result.rows[0];
        return row === undefined ? ok(null) : restore(row);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
