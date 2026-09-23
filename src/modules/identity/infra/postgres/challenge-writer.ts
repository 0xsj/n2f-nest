import {
  err,
  type Failure,
  type Result,
} from '../../../../shared/errors/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { assertEventWork } from '../../../../shared/events/index.js';
import type { Envelope } from '../../../../shared/events/index.js';
import { map, violatedUnique } from '../../../../shared/postgres/index.js';
import { challengeExists } from '../failures.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { VerificationChallenge } from '../../domain/index.js';
import type { VerificationChallengeWriter } from '../../app/ports/index.js';
import type { TransactionDatabase } from './database.js';

export class PostgresVerificationChallengeWriter
  implements VerificationChallengeWriter
{
  constructor(private readonly database: TransactionDatabase) {}

  commit(
    input: Readonly<{
      challenge: VerificationChallenge;
      tokenDigest: SecretString;
      event: Envelope;
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction(async (transaction) => {
      const provenance = assertEventWork(input.event, input.work);
      if (!provenance.ok) return provenance;

      try {
        await transaction.query(
          `INSERT INTO public.n2f_identity_verification_challenges
            (id,identity_id,purpose,status,issued_at,expires_at,consumed_at,token_digest)
           VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8)`,
          [
            input.challenge.id,
            input.challenge.identityId,
            input.challenge.purpose,
            input.challenge.status,
            input.challenge.issuedAt,
            input.challenge.expiresAt,
            input.challenge.consumedAt,
            input.tokenDigest.reveal(),
          ],
        );
        return enqueue(transaction, input.event);
      } catch (cause) {
        return err(
          violatedUnique(cause) === 'n2f_identity_verification_challenges_pkey'
            ? challengeExists()
            : map(cause),
        );
      }
    }, signal);
  }
}
