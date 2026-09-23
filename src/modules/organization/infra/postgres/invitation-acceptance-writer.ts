import { err, type Failure, type Result } from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import {
  map,
  violatedUnique,
  type TransactionDatabase,
} from '../../../../shared/postgres/index.js';
import {
  CONSTRAINTS,
  acceptanceConflict,
  acceptedMembershipExists,
} from '../failures.js';
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
        // The pending guard keeps acceptance terminal; the version guard also
        // refuses an acceptance derived from a superseded read.
        const accepted = await transaction.query(
          `UPDATE public.n2f_organization_invitations
              SET status='accepted',updated_at=$2,accepted_at=$2,version=version+1
            WHERE id=$1::uuid AND status='pending' AND version=$3`,
          [input.invitation.id, input.invitation.updatedAt, input.invitation.version],
        );
        if (accepted.rowCount !== 1) return err(acceptanceConflict());

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
        const constraint = violatedUnique(cause);
        return err(
          constraint === CONSTRAINTS.membershipPkey ||
            constraint === CONSTRAINTS.membershipIdentity
            ? acceptedMembershipExists()
            : map(cause),
        );
      }
    }, input.signal);
  }
}
