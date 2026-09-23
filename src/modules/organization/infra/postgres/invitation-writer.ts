import { err, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import {
  map,
  missingOrStale,
  violatedUnique,
  type TransactionDatabase,
} from '../../../../shared/postgres/index.js';
import { UNSAVED } from '../../../../shared/version/index.js';
import type { InvitationCommit, InvitationWriter } from '../../app/index.js';
import {
  CONSTRAINTS,
  invitationExists,
  invitationNotFound,
  pendingInvitationExists,
  staleWrite,
} from '../failures.js';

/**
 * Inserts a new invitation or updates a loaded one. An update applies only
 * when the row still holds the version the command read, so a revocation
 * cannot overwrite an acceptance that committed first.
 */
export class PostgresInvitationWriter implements InvitationWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: InvitationCommit): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;
      const invitation = input.invitation;
      try {
        if (invitation.version === UNSAVED) {
          await transaction.query(
            `INSERT INTO public.n2f_organization_invitations
              (id,organization_id,identity_id,role,status,created_at,updated_at,expires_at,accepted_at,revoked_at)
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8,$9,$10)`,
            [
              invitation.id,
              invitation.organizationId,
              invitation.identityId,
              invitation.role,
              invitation.status,
              invitation.createdAt,
              invitation.updatedAt,
              invitation.expiresAt,
              invitation.acceptedAt,
              invitation.revokedAt,
            ],
          );
        } else {
          const updated = await transaction.query(
            `UPDATE public.n2f_organization_invitations
                SET role=$2,status=$3,updated_at=$4,expires_at=$5,accepted_at=$6,revoked_at=$7,
                    version=version+1
              WHERE id=$1::uuid AND version=$8`,
            [
              invitation.id,
              invitation.role,
              invitation.status,
              invitation.updatedAt,
              invitation.expiresAt,
              invitation.acceptedAt,
              invitation.revokedAt,
              invitation.version,
            ],
          );
          if (updated.rowCount !== 1) {
            return err(
              (await missingOrStale(
                transaction,
                'public.n2f_organization_invitations',
                invitation.id,
              )) === 'missing'
                ? invitationNotFound()
                : staleWrite(),
            );
          }
        }
        return enqueue(transaction, input.event);
      } catch (cause) {
        switch (violatedUnique(cause)) {
          case CONSTRAINTS.invitationPkey:
            return err(invitationExists());
          case CONSTRAINTS.pendingInvitation:
            return err(pendingInvitationExists());
          default:
            return err(map(cause));
        }
      }
    }, input.signal);
  }
}
