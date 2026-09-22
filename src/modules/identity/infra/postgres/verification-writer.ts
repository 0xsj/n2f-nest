import {
  err,
  failure,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { map } from '../../../../shared/postgres/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { Identity, VerificationChallenge } from '../../domain/index.js';
import type { VerificationWriter } from '../../app/ports/index.js';
import type { TransactionDatabase } from './database.js';

const notFound = (message: string, type: string): Failure =>
  failure('not_found', message, { type });

export class PostgresVerificationWriter implements VerificationWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(
    input: Readonly<{
      identity: Identity;
      challenge: VerificationChallenge;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;

      try {
        const identity = await transaction.query(
          `UPDATE public.n2f_identity_identities
              SET status=$2,updated_at=$3,verified_at=$4
            WHERE id=$1::uuid`,
          [
            input.identity.id,
            input.identity.status,
            input.identity.updatedAt,
            input.identity.verifiedAt,
          ],
        );
        if (identity.rowCount !== 1) {
          return err(notFound('identity was not found', 'identity.not_found'));
        }

        const challenge = await transaction.query(
          `UPDATE public.n2f_identity_verification_challenges
              SET status=$2,consumed_at=$3
            WHERE id=$1::uuid AND identity_id=$4::uuid`,
          [
            input.challenge.id,
            input.challenge.status,
            input.challenge.consumedAt,
            input.identity.id,
          ],
        );
        if (challenge.rowCount !== 1) {
          return err(
            notFound(
              'verification challenge was not found',
              'identity.verification_not_found',
            ),
          );
        }

        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
