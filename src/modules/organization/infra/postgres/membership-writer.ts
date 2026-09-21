import {
  err,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { map, type TransactionDatabase } from '../../../../shared/postgres/index.js';
import type { MembershipWriter } from '../../app/index.js';
import type { MembershipCommit } from '../../app/ports/index.js';

export class PostgresMembershipWriter implements MembershipWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: MembershipCommit): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;

      try {
        const inserted = await transaction.query(
          `INSERT INTO public.signals_organization_memberships
            (id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO NOTHING`,
          [
            input.membership.id,
            input.membership.organizationId,
            input.membership.identityId,
            input.membership.role,
            input.membership.status,
            input.membership.createdAt,
            input.membership.updatedAt,
            input.membership.revokedAt,
          ],
        );
        if (inserted.rowCount !== 1) {
          const updated = await transaction.query(
            `UPDATE public.signals_organization_memberships
                SET role=$2,status=$3,updated_at=$4,revoked_at=$5
              WHERE id=$1::uuid`,
            [
              input.membership.id,
              input.membership.role,
              input.membership.status,
              input.membership.updatedAt,
              input.membership.revokedAt,
            ],
          );
          if (updated.rowCount !== 1) {
            return err({
              kind: 'not_found',
              message: 'membership was not found',
              type: 'organization.membership.not_found',
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
