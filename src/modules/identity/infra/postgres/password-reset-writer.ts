import type pg from 'pg';
import { err, failure, type Failure, type Result } from '../../../../shared/errors/index.js';
import { enqueue } from '../../../../shared/events/postgres/index.js';
import { assertEventWork, type Envelope } from '../../../../shared/events/index.js';
import { map, missingOrStale } from '../../../../shared/postgres/index.js';
import type { WorkContext } from '../../../../shared/provenance/index.js';
import type { SecretString } from '../../../../shared/secret/index.js';
import type { PasswordResetWriter, SessionEviction } from '../../app/ports/index.js';
import type { Credential, Identity, VerificationChallenge } from '../../domain/index.js';
import { staleWrite } from '../failures.js';
import type { TransactionDatabase } from './database.js';

/** A version-checked update that matched no row: missing, or superseded. */
async function refused(
  transaction: pg.PoolClient,
  table: string,
  id: string,
  missing: Failure,
): Promise<Failure> {
  return (await missingOrStale(transaction, table, id)) === 'missing' ? missing : staleWrite();
}

export class PostgresPasswordResetWriter implements PasswordResetWriter {
  constructor(private readonly database: TransactionDatabase) {}

  commit(
    input: Readonly<{
      challenge: VerificationChallenge;
      credential: Credential;
      previousUpdatedAt: Date;
      passwordHash: SecretString;
      identity: Identity | null;
      revoked: readonly SessionEviction[];
      events: readonly Envelope[];
      work: WorkContext;
    }>,
    signal?: AbortSignal,
  ): Promise<Result<void, Failure>> {
    return this.database.transaction<void>(async (transaction) => {
      for (const event of input.events) {
        const provenance = assertEventWork(event, input.work);
        if (!provenance.ok) return provenance;
      }

      try {
        // First, so a login holding the credential FOR SHARE finishes (and
        // its session becomes visible below) before the reset proceeds.
        const credential = await transaction.query(
          `UPDATE public.n2f_identity_credentials
              SET password_hash=$2,updated_at=$3
            WHERE id=$1::uuid AND status='active' AND updated_at=$4`,
          [input.credential.id, input.passwordHash.reveal(), input.credential.updatedAt, input.previousUpdatedAt],
        );
        if (credential.rowCount !== 1) return err(staleWrite());

        const challenge = await transaction.query(
          `UPDATE public.n2f_identity_verification_challenges
              SET status=$2,consumed_at=$3,version=version+1
            WHERE id=$1::uuid AND purpose='password_reset' AND version=$4`,
          [input.challenge.id, input.challenge.status, input.challenge.consumedAt, input.challenge.version],
        );
        if (challenge.rowCount !== 1) {
          return err(
            await refused(
              transaction,
              'public.n2f_identity_verification_challenges',
              input.challenge.id,
              failure('not_found', 'verification challenge was not found', {
                type: 'identity.verification_not_found',
              }),
            ),
          );
        }

        if (input.identity) {
          const identity = await transaction.query(
            `UPDATE public.n2f_identity_identities
                SET status=$2,updated_at=$3,verified_at=$4,version=version+1
              WHERE id=$1::uuid AND version=$5`,
            [
              input.identity.id,
              input.identity.status,
              input.identity.updatedAt,
              input.identity.verifiedAt,
              input.identity.version,
            ],
          );
          if (identity.rowCount !== 1) {
            return err(
              await refused(
                transaction,
                'public.n2f_identity_identities',
                input.identity.id,
                failure('not_found', 'identity was not found', { type: 'identity.not_found' }),
              ),
            );
          }
        }

        for (const { session } of input.revoked) {
          const revoked = await transaction.query(
            `UPDATE public.n2f_identity_sessions
                SET status=$2,revoked_at=$3,version=version+1
              WHERE id=$1::uuid AND version=$4`,
            [session.id, session.status, session.revokedAt, session.version],
          );
          if (revoked.rowCount !== 1) return err(staleWrite());
        }
        // A session opened after the list was read would outlive the reset.
        const survivors = await transaction.query(
          `SELECT 1 FROM public.n2f_identity_sessions
            WHERE identity_id=$1::uuid AND status='active' LIMIT 1`,
          [input.credential.identityId],
        );
        if ((survivors.rowCount ?? 0) > 0) return err(staleWrite());

        for (const event of input.events) {
          const queued = await enqueue(transaction, event);
          if (!queued.ok) return queued;
        }
        return { ok: true, value: undefined };
      } catch (cause) {
        return err(map(cause));
      }
    }, signal);
  }
}
