import {
  err,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import {
  map,
  missingOrStale,
  violatedUnique,
  type TransactionDatabase,
} from '../../../../shared/postgres/index.js';
import { UNSAVED } from '../../../../shared/version/index.js';
import type { MembershipWriter } from '../../app/index.js';
import type { MembershipCommit } from '../../app/ports/index.js';
import {
  CONSTRAINTS,
  membershipExists,
  membershipNotFound,
  staleWrite,
} from '../failures.js';

/**
 * Inserts a new membership or updates a loaded one. An update applies only
 * when the row still holds the version the command read.
 */
export class PostgresMembershipWriter implements MembershipWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(input: MembershipCommit): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;
      const membership = input.membership;

      try {
        if (membership.version === UNSAVED) {
          await transaction.query(
            `INSERT INTO public.n2f_organization_memberships
              (id,organization_id,identity_id,role,status,created_at,updated_at,revoked_at)
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)`,
            [
              membership.id,
              membership.organizationId,
              membership.identityId,
              membership.role,
              membership.status,
              membership.createdAt,
              membership.updatedAt,
              membership.revokedAt,
            ],
          );
        } else {
          const updated = await transaction.query(
            `UPDATE public.n2f_organization_memberships
                SET role=$2,status=$3,updated_at=$4,revoked_at=$5,version=version+1
              WHERE id=$1::uuid AND version=$6`,
            [
              membership.id,
              membership.role,
              membership.status,
              membership.updatedAt,
              membership.revokedAt,
              membership.version,
            ],
          );
          if (updated.rowCount !== 1) {
            return err(
              (await missingOrStale(
                transaction,
                'public.n2f_organization_memberships',
                membership.id,
              )) === 'missing'
                ? membershipNotFound()
                : staleWrite(),
            );
          }
        }

        return enqueue(transaction, input.event);
      } catch (cause) {
        const constraint = violatedUnique(cause);
        return err(
          constraint === CONSTRAINTS.membershipPkey ||
            constraint === CONSTRAINTS.membershipIdentity
            ? membershipExists()
            : map(cause),
        );
      }
    }, input.signal);
  }
}
