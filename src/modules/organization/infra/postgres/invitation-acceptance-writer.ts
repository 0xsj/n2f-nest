import { err, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type {
  InvitationAcceptanceCommit,
  InvitationAcceptanceWriter,
} from '../../app/index.js';

export class PostgresInvitationAcceptanceWriter implements InvitationAcceptanceWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: InvitationAcceptanceCommit): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      for (const event of input.events) {
        const provenance = assertEventWork(event, input.work);
        if (!provenance.ok) return provenance;
      }

      try {
        const accepted = await transaction.query(
          `UPDATE public.n2f_organization_invitations
              SET status='accepted',updated_at=$2,accepted_at=$2
            WHERE id=$1::uuid AND status='pending'`,
          [input.invitation.id, input.invitation.updatedAt],
        );
        if (accepted.rowCount !== 1) {
          return err({
            kind: 'conflict',
            message: 'invitation is no longer pending',
            type: 'organization.invitation.acceptance_conflict',
          });
        }

        await transaction.query(
          `INSERT INTO public.n2f_organization_memberships
            (id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'active',$5,$5,NULL)`,
          [
            input.membership.id,
            input.membership.organizationId,
            input.membership.identityId,
            input.membership.role,
            input.membership.createdAt,
          ],
        );

        for (const event of input.events) {
          const enqueued = await enqueue(transaction, event);
          if (!enqueued.ok) return enqueued;
        }
        return { ok: true, value: undefined };
      } catch (cause) {
        return err(map(cause));
      }
    }, input.signal);
  }
}
