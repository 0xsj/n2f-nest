import { err, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { InvitationCommit, InvitationWriter } from '../../app/index.js';

export class PostgresInvitationWriter implements InvitationWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: InvitationCommit): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;
      try {
        const inserted = await transaction.query(
          `INSERT INTO public.n2f_organization_invitations
            (id,organization_id,identity_id,role,status,created_at,updated_at,expires_at,accepted_at,revoked_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO NOTHING`,
          [
            input.invitation.id,
            input.invitation.organizationId,
            input.invitation.identityId,
            input.invitation.role,
            input.invitation.status,
            input.invitation.createdAt,
            input.invitation.updatedAt,
            input.invitation.expiresAt,
            input.invitation.acceptedAt,
            input.invitation.revokedAt,
          ],
        );
        if (inserted.rowCount !== 1) {
          const updated = await transaction.query(
            `UPDATE public.n2f_organization_invitations
                SET role=$2,status=$3,updated_at=$4,expires_at=$5,accepted_at=$6,revoked_at=$7
              WHERE id=$1::uuid`,
            [
              input.invitation.id,
              input.invitation.role,
              input.invitation.status,
              input.invitation.updatedAt,
              input.invitation.expiresAt,
              input.invitation.acceptedAt,
              input.invitation.revokedAt,
            ],
          );
          if (updated.rowCount !== 1) {
            return err({
              kind: 'not_found',
              message: 'invitation was not found',
              type: 'organization.invitation.not_found',
            });
          }
        }
        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(map(cause));
      }
    }, input.signal);
  }
}
